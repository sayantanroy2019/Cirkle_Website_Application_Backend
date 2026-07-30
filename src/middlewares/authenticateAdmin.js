import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';

// Verifies with ADMIN_JWT_SECRET — a distinct secret from the user JWT_SECRET,
// so a user (attendee) token can never authenticate against admin routes and
// vice versa. Signature verification alone rejects a cross-signed token.
const authenticateAdmin = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET, { algorithms: ['HS256'] });

        // Re-check against the DB on every request — a deactivated admin's
        // existing token must stop working immediately, not just at expiry.
        // Role is read fresh here too, so a role change takes effect right away.
        const result = await pool.query(
            'SELECT id, role, is_active FROM admins WHERE id = $1',
            [decoded.adminId]
        );

        if (result.rows.length === 0 || !result.rows[0].is_active) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        req.admin = { adminId: result.rows[0].id, role: result.rows[0].role };
        next();
    } catch (err) {
        if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        console.error('Admin auth middleware error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export default authenticateAdmin;
