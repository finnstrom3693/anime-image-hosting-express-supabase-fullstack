const express = require('express');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config(); // Load environment variables

const router = express.Router();

// Ensure Supabase environment variables exist
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    throw new Error("Missing Supabase environment variables. Check your .env file.");
}

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const saltRounds = 10; // Salt rounds for bcrypt

// Login route
router.get('/login', (req, res) => {
    res.render('login', { title: 'Login' });
});

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Get user by email
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        if (userError || !user) throw new Error('Invalid email or password.');

        // Compare hashed password
        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) throw new Error('Invalid email or password.');

        req.session.user = {
            id: user.id,
            email: user.email,
            username: user.username
        };

        res.redirect(req.query.redirect || '/');
    } catch (error) {
        res.render('login', { title: 'Login', error: error.message || 'Login failed. Please try again.' });
    }
});

// Logout route
router.get('/logout', async (req, res) => {
    try {
        await supabase.auth.signOut();
        req.session.destroy();
    } catch (error) {
        console.error('Logout error:', error.message);
    }
    res.redirect('/');
});

// Register route
router.get('/register', (req, res) => {
    res.render('register', { title: 'Register' });
});

router.post('/register', async (req, res) => {
    try {
        const { username, email, password, confirmPassword } = req.body;

        if (password !== confirmPassword) {
            return res.render('register', { title: 'Register', error: 'Passwords do not match' });
        }

        // Hash the password before saving
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Sign up the user via Supabase Auth
        const { data, error } = await supabase.auth.signUp({
            email,
            password, // Supabase Auth handles its own password storage
            options: {
                data: { username }
            }
        });

        if (error) throw error;

        // Save user data in the "users" table with hashed password
        const { error: insertError } = await supabase
            .from('users')
            .insert([{ 
                id: data.user.id, 
                username, 
                email, 
                password_hash: hashedPassword,
            }]);

        if (insertError) throw insertError;

        // Set session immediately
        req.session.user = {
            id: data.user.id,
            email: data.user.email,
            username: username
        };
        
        return res.redirect('/');
    } catch (error) {
        res.render('register', { title: 'Register', error: error.message || 'Failed to register. Please try again.' });
    }
});

module.exports = router;