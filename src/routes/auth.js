import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';

const authRouter = express.Router();

// Validates Indian mobile numbers: +91 followed by 10 digits starting with 6-9
const isValidIndianPhone = (phone) => {
    return /^\+91[6-9]\d{9}$/.test(phone);
};

// POST /auth/login
// Creates user if new, signs in if returning — one endpoint handles both
// Phone-as-password is a Phase 1 stub; replaced by OTP at final phase
authRouter.post('/login', async (req, res) => {
    const { phone } = req.body;

    if (!phone || !isValidIndianPhone(phone)) {
        return res.status(400).json({ error: 'Invalid phone number' });
    }

    // The pool manages multiple database connections. Here we're checking one out — like taking a specific checkout lane at a supermarket. 
    // We need an individual client (not just the pool) because we need to run a transaction for new users. 
    // A transaction requires holding the same connection across multiple queries.
    const client = await pool.connect();

    try {
        const existing = await client.query(
            'SELECT id, role, current_onboarding_step, partial_profile_complete, password_hash FROM users WHERE phone = $1',
            [phone]
        );

        let userId, role, currentOnboardingStep, partialProfileComplete, isNewUser;

        if (existing.rows.length === 0) {
            // --- NEW USER ---
            const passwordHash = await bcrypt.hash(phone, 10);

            await client.query('BEGIN');

            const userResult = await client.query(
                `INSERT INTO users (phone, password_hash)
                 VALUES ($1, $2)
                 RETURNING id, role, current_onboarding_step, partial_profile_complete`,
                [phone, passwordHash]
            );

            const newUser = userResult.rows[0];

            // Create empty profile row — all onboarding columns null by design
            await client.query(
                'INSERT INTO profiles (user_id) VALUES ($1)',
                [newUser.id]
            );

            await client.query('COMMIT');

            userId = newUser.id;
            role = newUser.role;
            currentOnboardingStep = newUser.current_onboarding_step;
            partialProfileComplete = newUser.partial_profile_complete;
            isNewUser = true;

        } else {
            // --- RETURNING USER ---
            const user = existing.rows[0];
            const valid = await bcrypt.compare(phone, user.password_hash);

            if (!valid) {
                return res.status(401).json({ error: 'Authentication failed' });
            }

            userId = user.id;
            role = user.role;
            currentOnboardingStep = user.current_onboarding_step;
            partialProfileComplete = user.partial_profile_complete;
            isNewUser = false;
        }

        const token = jwt.sign(
            { userId, role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            token,
            isNewUser,
            currentOnboardingStep,
            partialProfileComplete
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('POST /auth/login error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

export default authRouter;