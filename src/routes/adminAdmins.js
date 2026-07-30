import express from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../config/db.js';
import authenticateAdmin from '../middlewares/authenticateAdmin.js';
import { can } from '../utils/permissions.js';

const adminAdminsRouter = express.Router();

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_ROLES = ['administrative', 'business_development'];
const MIN_PASSWORD_LENGTH = 8;

function toResponse(row) {
    return {
        id:          row.id,
        email:       row.email,
        displayName: row.display_name,
        role:        row.role,
        isActive:    row.is_active,
        createdAt:   row.created_at
    };
}

// Every route here requires admin auth; account management additionally
// requires the manage_admins capability — administrative admins only.
adminAdminsRouter.use(authenticateAdmin);

function requireManageAdmins(req, res, next) {
    if (!can(req.admin, 'manage_admins')) {
        return res.status(403).json({ error: 'You do not have permission to manage admin accounts' });
    }
    next();
}

// POST /admin/admins
// Creates a new admin account (BD or administrative). This is how
// administrative admins create BD team accounts.
adminAdminsRouter.post('/', requireManageAdmins, async (req, res) => {
    const { email, password, displayName, role } = req.body;

    if (!email || !emailRegex.test(email)) {
        return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    if (!displayName || !displayName.trim()) {
        return res.status(400).json({ error: 'displayName is required' });
    }
    if (!role || !ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` });
    }

    const normalizedEmail = email.trim().toLowerCase();

    try {
        const existing = await pool.query('SELECT id FROM admins WHERE email = $1', [normalizedEmail]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'An admin with this email already exists' });
        }

        // Hashed immediately — plaintext password is never logged or stored.
        const passwordHash = await bcrypt.hash(password, 10);

        const inserted = await pool.query(
            `INSERT INTO admins (email, password_hash, display_name, role)
             VALUES ($1, $2, $3, $4)
             RETURNING id, email, display_name, role, is_active, created_at`,
            [normalizedEmail, passwordHash, displayName.trim(), role]
        );

        res.status(201).json({ admin: toResponse(inserted.rows[0]) });

    } catch (err) {
        console.error('POST /admin/admins error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/admins
// Lists all admin accounts.
adminAdminsRouter.get('/', requireManageAdmins, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, email, display_name, role, is_active, created_at
             FROM admins
             ORDER BY created_at ASC`
        );
        res.json({ admins: result.rows.map(toResponse) });

    } catch (err) {
        console.error('GET /admin/admins error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /admin/admins/:id
// Partial update — display_name, role, is_active. Only fields present in
// the body are changed.
adminAdminsRouter.patch('/:id', requireManageAdmins, async (req, res) => {
    const { id } = req.params;
    const { displayName, role, isActive } = req.body;

    if (displayName !== undefined && !displayName.trim()) {
        return res.status(400).json({ error: 'displayName cannot be empty' });
    }
    if (role !== undefined && !ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` });
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (displayName !== undefined) {
        updates.push(`display_name = $${paramCount++}`);
        values.push(displayName.trim());
    }
    if (role !== undefined) {
        updates.push(`role = $${paramCount++}`);
        values.push(role);
    }
    if (isActive !== undefined) {
        updates.push(`is_active = $${paramCount++}`);
        values.push(isActive);
    }

    if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);

    try {
        const result = await pool.query(
            `UPDATE admins
             SET ${updates.join(', ')}, updated_at = now()
             WHERE id = $${paramCount}
             RETURNING id, email, display_name, role, is_active, created_at`,
            values
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Admin not found' });
        }

        res.json({ admin: toResponse(result.rows[0]) });

    } catch (err) {
        console.error('PATCH /admin/admins/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default adminAdminsRouter;
