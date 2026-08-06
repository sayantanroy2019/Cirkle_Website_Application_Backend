import express from 'express';
import { pool } from '../config/db.js';
import authenticateAdmin from '../middlewares/authenticateAdmin.js';
import { recordAudit, diffChanges } from '../utils/audit.js';

const adminTicketCategoriesRouter = express.Router();

// Both admin roles may manage the catalogue — it's event-adjacent reference
// data, like cities. Not gated by manage_admins.
adminTicketCategoriesRouter.use(authenticateAdmin);

function toResponse(row) {
    return {
        id:        row.id,
        name:      row.name,
        isActive:  row.is_active,
        createdAt: row.created_at
    };
}

// Collapses internal whitespace too, so 'Couple   Pass' and 'Couple Pass'
// are the same name rather than two rows that look identical in a dropdown.
function normalizeName(raw) {
    if (typeof raw !== 'string') {
        return null;
    }
    const name = raw.trim().replace(/\s+/g, ' ');
    return name === '' ? null : name;
}

// GET /admin/ticket-categories?isActive=true|false
// The read path the admin event form uses to populate its category dropdown
// (call it with isActive=true — retired names must not be offered for new
// events, even though existing events keep referencing them).
adminTicketCategoriesRouter.get('/', async (req, res) => {
    const { isActive } = req.query;

    if (isActive !== undefined && isActive !== 'true' && isActive !== 'false') {
        return res.status(400).json({ error: 'isActive must be true or false' });
    }

    try {
        const conditions = [];
        const values = [];
        if (isActive !== undefined) {
            conditions.push('is_active = $1');
            values.push(isActive === 'true');
        }

        const result = await pool.query(
            `SELECT id, name, is_active, created_at
             FROM ticket_categories
             ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
             ORDER BY name ASC`,
            values
        );

        res.json({ ticketCategories: result.rows.map(toResponse) });

    } catch (err) {
        console.error('GET /admin/ticket-categories error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /admin/ticket-categories
// Adds a name to the catalogue. Uniqueness is case-insensitive: 'VIP' and
// 'vip' are the same name, so the dropdown can't fill up with near-duplicates.
adminTicketCategoriesRouter.post('/', async (req, res) => {
    const name = normalizeName(req.body.name);

    if (!name) {
        return res.status(400).json({ error: 'name is required' });
    }

    const client = await pool.connect();

    try {
        const existing = await client.query(
            'SELECT id FROM ticket_categories WHERE lower(name) = lower($1)',
            [name]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'A ticket category with this name already exists' });
        }

        await client.query('BEGIN');

        const inserted = await client.query(
            `INSERT INTO ticket_categories (name)
             VALUES ($1)
             RETURNING id, name, is_active, created_at`,
            [name]
        );
        const category = inserted.rows[0];

        await recordAudit(client, {
            adminId: req.admin.adminId,
            action: 'create',
            entityType: 'ticket_category',
            entityId: category.id,
            changes: { name: category.name, isActive: category.is_active }
        });

        await client.query('COMMIT');

        res.status(201).json({ ticketCategory: toResponse(category) });

    } catch (err) {
        await client.query('ROLLBACK');
        // The case-insensitive unique index is the real guard — the SELECT
        // above only makes the common case a clean 409 instead of a race.
        if (err.code === '23505') {
            return res.status(409).json({ error: 'A ticket category with this name already exists' });
        }
        console.error('POST /admin/ticket-categories error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// PATCH /admin/ticket-categories/:id
// Rename and/or retire. There is deliberately no DELETE: a category may be
// referenced by events (and later tickets and orders), so retiring with
// isActive=false is the only removal. Retiring never touches events that
// already reference the name.
adminTicketCategoriesRouter.patch('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, isActive } = req.body;

    if (name === undefined && isActive === undefined) {
        return res.status(400).json({ error: 'No fields to update' });
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    let normalizedName;
    if (name !== undefined) {
        normalizedName = normalizeName(name);
        if (!normalizedName) {
            return res.status(400).json({ error: 'name cannot be empty' });
        }
    }

    const client = await pool.connect();

    try {
        const beforeResult = await client.query(
            'SELECT id, name, is_active FROM ticket_categories WHERE id = $1',
            [id]
        );
        if (beforeResult.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket category not found' });
        }
        const before = beforeResult.rows[0];

        if (normalizedName !== undefined) {
            const dupe = await client.query(
                'SELECT id FROM ticket_categories WHERE lower(name) = lower($1) AND id <> $2',
                [normalizedName, id]
            );
            if (dupe.rows.length > 0) {
                return res.status(409).json({ error: 'A ticket category with this name already exists' });
            }
        }

        const updates = [];
        const values = [];
        let paramCount = 1;

        if (normalizedName !== undefined) {
            updates.push(`name = $${paramCount++}`);
            values.push(normalizedName);
        }
        if (isActive !== undefined) {
            updates.push(`is_active = $${paramCount++}`);
            values.push(isActive);
        }
        values.push(id);

        await client.query('BEGIN');

        const afterResult = await client.query(
            `UPDATE ticket_categories
             SET ${updates.join(', ')}
             WHERE id = $${paramCount}
             RETURNING id, name, is_active, created_at`,
            values
        );
        const after = afterResult.rows[0];

        const changes = diffChanges(before, after, ['name', 'is_active']);
        if (Object.keys(changes).length > 0) {
            await recordAudit(client, {
                adminId: req.admin.adminId,
                action: 'update',
                entityType: 'ticket_category',
                entityId: id,
                changes
            });
        }

        await client.query('COMMIT');

        res.json({ ticketCategory: toResponse(after) });

    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: 'A ticket category with this name already exists' });
        }
        console.error('PATCH /admin/ticket-categories/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

export default adminTicketCategoriesRouter;
