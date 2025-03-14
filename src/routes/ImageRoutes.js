const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const requireAuth = require('../middleware/requireAuth');
const fs = require('fs');
const path = require('path');

const storage = multer.memoryStorage();
const upload = multer({ 
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    }
});

async function getImagesFromDatabase() {
    const { data, error } = await supabase
      .from('images') // Your Supabase table
      .select('*');
  
    if (error) {
      console.error('Error fetching images:', error);
      return [];
    }
  
    return data.map(image => ({
      id: image.id,
      title: image.title,
      description: image.description,
      created_at: image.created_at,
      image_url: `${supabaseUrl}/storage/v1/object/public/${image.image_path}`, // Construct public URL
      likes: image.likes || 0,
    }));
}

async function getOrientation(buffer) {
    try {
        const metadata = await sharp(buffer).metadata();
        const { width, height } = metadata;
        return width > height ? 'landscape' : width < height ? 'portrait' : 'square';
    } catch (error) {
        return 'unknown';
    }
}

router.get('/upload', requireAuth, (req, res) => {
    res.render('upload', { title: 'Upload Image' });
});

router.post('/upload', requireAuth, upload.single('image'), async (req, res) => {
    try {
        if (!req.session.user) {
            return res.render('upload', { title: 'Upload Image', error: 'User session not found. Please log in.' });
        }

        if (!req.file) {
            return res.render('upload', { title: 'Upload Image', error: 'No file uploaded' });
        }

        const { title, description, tags } = req.body;
        const orientation = await getOrientation(req.file.buffer);
        const userId = req.session.user.id;
        const fileName = `${userId}_${Date.now()}.png`;
        const uploadPath = path.join(__dirname, '../uploads', fileName);

        // Ensure the upload directory exists
        if (!fs.existsSync(path.join(__dirname, '../uploads'))) {
            fs.mkdirSync(path.join(__dirname, '../uploads'), { recursive: true });
        }

        // Optimize and save the image locally
        const optimizedImage = await sharp(req.file.buffer)
            .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
            .toBuffer();

        fs.writeFileSync(uploadPath, optimizedImage);

        // Construct public URL (assuming the upload folder is accessible via /uploads/)
        const publicUrl = `/uploads/${fileName}`;

        // Insert metadata into the database
        const { data: dbData, error: dbError } = await supabase.from('images').insert([
            {
                title: title || 'Untitled',
                description: description || '',
                tags: Array.isArray(tags) ? tags.join(', ') : tags || '',
                orientation,
                filename: fileName,
                url: publicUrl,
                user_id: userId,
                username: req.session.user.username
            }
        ]);

        if (dbError) throw new Error(`Database Insert Error: ${dbError.message}`);

        res.render('upload', { title: 'Upload Image', success: 'Image uploaded successfully!' });
    } catch (error) {
        res.render('upload', { title: 'Upload Image', error: `Upload failed: ${error.message}` });
    }
});

router.get('/my-images', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        
        // Using Supabase instead of direct db.query
        const { data: images, error } = await supabase
            .from('images')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
            
        if (error) throw new Error(`Database Fetch Error: ${error.message}`);
        
        res.render('my-image-list', { 
            title: 'My Images',
            images: images || []
        });
    } catch (error) {
        console.error(error);
        res.status(500).render('error', { 
            title: 'Error', 
            message: `Failed to load your images: ${error.message}` 
        });
    }
});

router.get('/images/my-images', async (req, res) => {
    try {
      const images = await getImagesFromDatabase(); // Fetch images from DB
      res.render('my-image-list', { images, currentPage: 1, totalPages: 1 }); // Pass images to EJS
    } catch (error) {
      console.error(error);
      res.status(500).send('Server Error');
    }
});
  

router.get('/images', async (req, res) => {
    try {
        const search = req.query.search || '';
        const page = parseInt(req.query.page) || 1;
        const limit = 9;
        const offset = (page - 1) * limit;

        let query = supabase.from('images').select('*', { count: 'exact' });

        if (search) query = query.or(`title.ilike.%${search}%,tags.ilike.%${search}%`);

        const { data, error, count } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw new Error(`Database Fetch Error: ${error.message}`);

        const totalPages = Math.ceil(count / limit);

        res.render('imagelist', {
            title: 'Image Gallery',
            images: data || [],
            search,
            pagination: { currentPage: page, totalPages, totalItems: count }
        });
    } catch (error) {
        res.render('imagelist', { title: 'Image Gallery', error: `Failed to load images: ${error.message}`, images: [] });
    }
});

router.get('/images/:id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('images')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (error || !data) {
            return res.status(404).render('error', { title: 'Image Not Found', message: 'The requested image could not be found' });
        }

        res.render('imagedetail', { title: data.title, image: data });
    } catch (error) {
        res.status(500).render('error', { title: 'Error', message: `Server Error: ${error.message}` });
    }
});

// GET route for edit image form
router.get('/images/:id/edit', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('images')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (error || !data) {
            return res.status(404).render('error', { title: 'Image Not Found', message: 'The requested image could not be found' });
        }

        // Check if user is the owner of the image
        if (data.user_id !== req.session.user.id) {
            return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have permission to edit this image' });
        }

        res.render('edit-image', { title: `Edit ${data.title}`, image: data });
    } catch (error) {
        res.status(500).render('error', { title: 'Error', message: `Server Error: ${error.message}` });
    }
});

// POST route for updating image details
router.post('/images/:id/edit', requireAuth, async (req, res) => {
    try {
        // First, check if the image exists and belongs to the user
        const { data: imageData, error: fetchError } = await supabase
            .from('images')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (fetchError || !imageData) {
            return res.status(404).render('error', { title: 'Image Not Found', message: 'The requested image could not be found' });
        }

        // Check if user is the owner of the image
        if (imageData.user_id !== req.session.user.id) {
            return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have permission to edit this image' });
        }

        const { title, description, tags } = req.body;

        // Update the image metadata in the database
        const { data, error } = await supabase
            .from('images')
            .update({
                title: title || 'Untitled',
                description: description || '',
                tags: tags || '',
            })
            .eq('id', req.params.id);

        if (error) throw new Error(`Database Update Error: ${error.message}`);

        res.redirect(`/images/${req.params.id}`);
    } catch (error) {
        res.status(500).render('error', { title: 'Error', message: `Update failed: ${error.message}` });
    }
});

// POST route for deleting an image
router.post('/images/:id/delete', requireAuth, async (req, res) => {
    try {
        // First, check if the image exists and belongs to the user
        const { data: imageData, error: fetchError } = await supabase
            .from('images')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (fetchError || !imageData) {
            return res.status(404).render('error', { title: 'Image Not Found', message: 'The requested image could not be found' });
        }

        // Check if user is the owner of the image
        if (imageData.user_id !== req.session.user.id) {
            return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have permission to delete this image' });
        }

        // Delete the image file from the filesystem
        const filePath = path.join(__dirname, '../uploads', imageData.filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        // Delete the image metadata from the database
        const { error } = await supabase
            .from('images')
            .delete()
            .eq('id', req.params.id);

        if (error) throw new Error(`Database Delete Error: ${error.message}`);

        res.redirect('/images');
    } catch (error) {
        res.status(500).render('error', { title: 'Error', message: `Delete failed: ${error.message}` });
    }
});

module.exports = router;