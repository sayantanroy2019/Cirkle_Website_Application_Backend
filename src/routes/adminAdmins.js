import express from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../config/db.js';
import authenticateAdmin from '../middlewares/authenticateAdmin.js';
import { can } from '../utils/permissions.js';
import { recordAudit, diffChanges } from '../utils/audit.js';

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

/**
 * The two lockout rules, as a pure decision.
 *
 * Kept separate from the SQL so the rules can be proven exhaustively without
 * mutating the global admin population — which is shared state that other
 * suites depend on. The route supplies the numbers; this decides.
 *
 * @param {object}  before   the target's current row (role, is_active)
 * @param {object}  proposed { role, isActive } — undefined means unchanged
 * @param {boolean} isSelf   is the target the admin making the request
 * @param {number}  othersActiveAdministrative  active administrative admins
 *                                              OTHER than the target
 * @returns {{error: string, message: string}|null} null when the change is allowed
 */
export function assessLockout(before, proposed, isSelf, othersActiveAdministrative) {
    // Rule 1 — unconditional. Holds even with a dozen other admins, because
    // the failure is losing the session you are sitting in.
    if (proposed.isActive === false && isSelf) {
        return {
            error: 'cannot_deactivate_self',
            message: 'You cannot deactivate your own account.'
        };
    }

    // Rule 2 — only reachable when the target currently counts toward the
    // population. Any other change can add to it, never drain it.
    const countsNow = before.role === 'administrative' && before.is_active;
    if (!countsNow) {
        return null;
    }

    const roleAfter   = proposed.role     !== undefined ? proposed.role     : before.role;
    const activeAfter = proposed.isActive !== undefined ? proposed.isActive : before.is_active;
    const countsAfter = roleAfter === 'administrative' && activeAfter;

    if (!countsAfter && othersActiveAdministrative === 0) {
        return {
            error: 'last_administrative_admin',
            message: 'There must be at least one active administrative admin.'
        };
    }

    return null;
}

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

// GET /admin/admins/:id
// Single admin, for the edit screen. Same shape as the list rows.
adminAdminsRouter.get('/:id', requireManageAdmins, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT id, email, display_name, role, is_active, created_at
             FROM admins WHERE id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Admin not found' });
        }

        res.json({ admin: toResponse(result.rows[0]) });

    } catch (err) {
        console.error('GET /admin/admins/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /admin/admins/:id
// Partial update — display_name, role, is_active, password.
//
// Two lockout rules make admin management un-brickable. Both return 409 with
// a specific message, because a client needs to say WHY it was refused:
//
//   1. Nobody may deactivate their own account. Unconditional — it holds even
//      when a dozen other admins exist, because the failure mode is losing the
//      session you are sitting in.
//   2. The population of active administrative admins may never reach zero,
//      whether by deactivating the last one or demoting them to BD.
//
// Self-DEMOTION is deliberately not blanket-blocked: it is governed by rule 2
// alone, so an administrative admin may hand over and step down to BD as long
// as somebody else is still administrative. That matches the admin portal's
// model; those client-side guards are now UX on top of this, not the only
// defence.
adminAdminsRouter.patch('/:id', requireManageAdmins, async (req, res) => {
    const { id } = req.params;
    const { displayName, role, isActive, password } = req.body;

    if (displayName !== undefined && !displayName.trim()) {
        return res.status(400).json({ error: 'displayName cannot be empty' });
    }
    if (role !== undefined && !ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` });
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive must be a boolean' });
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH)) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    if (displayName === undefined && role === undefined && isActive === undefined && password === undefined) {
        return res.status(400).json({ error: 'No fields to update' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // One locking read covering BOTH the target row and the whole active
        // administrative population, ordered by id.
        //
        // This is the seat-race discipline applied to "the last admin
        // standing": the count must be taken under the same lock that the
        // update runs in, or two admins demoting each other simultaneously
        // would both read a population of two, both pass, and leave zero.
        // ORDER BY id gives every transaction the same lock order, so
        // competing requests queue instead of deadlocking.
        const locked = await client.query(
            `SELECT id, email, display_name, role, is_active
             FROM admins
             WHERE id = $1 OR (role = 'administrative' AND is_active = true)
             ORDER BY id
             FOR UPDATE`,
            [id]
        );

        const before = locked.rows.find(a => a.id === id);
        if (!before) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Admin not found' });
        }

        // Both rules, decided against numbers read under the lock above.
        const othersRemaining = locked.rows.filter(
            a => a.id !== id && a.role === 'administrative' && a.is_active
        ).length;

        const blocked = assessLockout(
            before,
            { role, isActive },
            id === req.admin.adminId,
            othersRemaining
        );
        if (blocked) {
            await client.query('ROLLBACK');
            return res.status(409).json(blocked);
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

        // Hashed immediately — the plaintext is never stored, returned or logged.
        let passwordChanged = false;
        if (password !== undefined) {
            updates.push(`password_hash = $${paramCount++}`);
            values.push(await bcrypt.hash(password, 10));
            passwordChanged = true;
        }

        values.push(id);

        const result = await client.query(
            `UPDATE admins
             SET ${updates.join(', ')}, updated_at = now()
             WHERE id = $${paramCount}
             RETURNING id, email, display_name, role, is_active, created_at`,
            values
        );
        const after = result.rows[0];

        const changes = diffChanges(before, after, ['display_name', 'role', 'is_active']);
        if (passwordChanged) {
            // Records THAT a reset happened, never the value — unlike the
            // ordinary from/to diffs above.
            changes.password = { from: 'set', to: 'reset' };
        }

        if (Object.keys(changes).length > 0) {
            await recordAudit(client, {
                adminId: req.admin.adminId,
                action: 'update',
                entityType: 'admin',
                entityId: id,
                changes
            });
        }

        await client.query('COMMIT');

        res.json({ admin: toResponse(after) });

    } catch (err) {
        await client.query('ROLLBACK');
        // 40P01 — deadlock. The ORDER BY id lock ordering above should prevent
        // it, but if two requests still collide, a retry is the honest answer
        // rather than a 500 that looks like a bug.
        if (err.code === '40P01') {
            return res.status(409).json({
                error: 'concurrent_admin_change',
                message: 'Another admin change was in progress. Please try again.'
            });
        }
        console.error('PATCH /admin/admins/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

export default adminAdminsRouter;
