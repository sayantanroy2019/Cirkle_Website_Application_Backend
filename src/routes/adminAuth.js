import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';

const adminAuthRouter = express.Router();

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /admin/auth/login
// Email/password login for admins — separate identity space from attendee
// phone/OTP auth. Deliberately generic 401 messages on both "no such email"
// and "wrong password" — never reveal whether an email exists in this system.
adminAuthRouter.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password || !emailRegex.test(email)) {
        return res.status(400).json({ error: 'Valid email and password are required' });
    }

    try {
        const result = await pool.query(
            'SELECT id, email, password_hash, display_name, role, is_active FROM admins WHERE email = $1',
            [email.trim().toLowerCase()]
        );

        if (result.rows.length === 0 || !result.rows[0].is_active) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const admin = result.rows[0];
        const valid = await bcrypt.compare(password, admin.password_hash);

        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { adminId: admin.id, role: admin.role },
            process.env.ADMIN_JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            token,
            admin: {
                id:          admin.id,
                email:       admin.email,
                displayName: admin.display_name,
                role:        admin.role
            }
        });

    } catch (err) {
        console.error('POST /admin/auth/login error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default adminAuthRouter;
