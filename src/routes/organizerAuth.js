import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';

const organizerAuthRouter = express.Router();

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /organizer/auth/login
// Email/password login for organizers — separate identity space from both
// attendee phone/OTP auth and admin auth. Deliberately generic 401 on
// unknown email, wrong password, or a deactivated account — never reveal
// which.
organizerAuthRouter.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password || !emailRegex.test(email)) {
        return res.status(400).json({ error: 'Valid email and password are required' });
    }

    try {
        const result = await pool.query(
            'SELECT id, email, password_hash, display_name, is_active FROM organizers WHERE email = $1',
            [email.trim().toLowerCase()]
        );

        if (result.rows.length === 0 || !result.rows[0].is_active) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const organizer = result.rows[0];
        const valid = await bcrypt.compare(password, organizer.password_hash);

        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { organizerId: organizer.id },
            process.env.ORGANIZER_JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            token,
            organizer: {
                id:          organizer.id,
                email:       organizer.email,
                displayName: organizer.display_name
            }
        });

    } catch (err) {
        console.error('POST /organizer/auth/login error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default organizerAuthRouter;
