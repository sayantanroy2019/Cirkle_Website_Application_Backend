import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';

// Verifies with ORGANIZER_JWT_SECRET — distinct from both JWT_SECRET (users)
// and ADMIN_JWT_SECRET (admins). Three actor types, three secrets, so no
// token can cross-authenticate in either direction.
const authenticateOrganizer = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.ORGANIZER_JWT_SECRET, { algorithms: ['HS256'] });

        // Re-check against the DB on every request — a deactivated organizer's
        // existing token must stop working immediately, not just at expiry.
        const result = await pool.query(
            'SELECT id, is_active FROM organizers WHERE id = $1',
            [decoded.organizerId]
        );

        if (result.rows.length === 0 || !result.rows[0].is_active) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        req.organizer = { organizerId: result.rows[0].id };
        next();
    } catch (err) {
        if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        console.error('Organizer auth middleware error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export default authenticateOrganizer;
