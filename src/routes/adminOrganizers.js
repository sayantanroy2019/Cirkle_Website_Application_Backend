import express from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../config/db.js';
import authenticateAdmin from '../middlewares/authenticateAdmin.js';
import { recordAudit, diffChanges } from '../utils/audit.js';
import { normalizeInstagram } from '../utils/socialHandles.js';

const adminOrganizersRouter = express.Router();

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// Both admin roles may manage organizers — not gated by manage_admins.
adminOrganizersRouter.use(authenticateAdmin);

function toResponse(row) {
    return {
        id:          row.id,
        email:       row.email,
        displayName: row.display_name,
        instagram:   row.instagram ?? null,
        isActive:    row.is_active,
        createdAt:   row.created_at,
        ...(row.event_count !== undefined ? { eventCount: parseInt(row.event_count, 10) } : {})
    };
}

/**
 * THE admin organizer projection — used by GET detail, create and edit alike.
 *
 * eventCount lives here rather than in the INSERT/UPDATE RETURNING clauses
 * because it is an aggregate, not a column. Before this, create and edit
 * returned an organizer WITHOUT it, so a client replacing its state with a
 * PATCH response saw the event count silently disappear from the row it had
 * just edited.
 *
 * @returns {Promise<object|null>}
 */
async function fetchOrganizerDetail(organizerId) {
    const result = await pool.query(
        `SELECT o.id, o.email, o.display_name, o.instagram, o.is_active, o.created_at,
                COUNT(e.id) AS event_count
         FROM organizers o
         LEFT JOIN events e ON e.organizer_id = o.id
         WHERE o.id = $1
         GROUP BY o.id`,
        [organizerId]
    );
    return result.rows.length > 0 ? toResponse(result.rows[0]) : null;
}

// POST /admin/organizers
// Onboards a new organizer — admin creates the account, then hands the
// organizer their credentials out of band.
adminOrganizersRouter.post('/', async (req, res) => {
    const { email, password, displayName, instagram } = req.body;

    if (!email || !emailRegex.test(email)) {
        return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    if (!displayName || !displayName.trim()) {
        return res.status(400).json({ error: 'displayName is required' });
    }

    let normalizedInstagram;
    try {
        normalizedInstagram = normalizeInstagram(instagram);
    } catch {
        return res.status(400).json({ error: 'Invalid Instagram handle' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const client = await pool.connect();

    try {
        const existing = await client.query('SELECT id FROM organizers WHERE email = $1', [normalizedEmail]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'An organizer with this email already exists' });
        }

        // Hashed immediately — plaintext password is never logged or stored.
        const passwordHash = await bcrypt.hash(password, 10);

        await client.query('BEGIN');

        const inserted = await client.query(
            `INSERT INTO organizers (email, password_hash, display_name, instagram)
             VALUES ($1, $2, $3, $4)
             RETURNING id, email, display_name, instagram, is_active, created_at`,
            [normalizedEmail, passwordHash, displayName.trim(), normalizedInstagram]
        );
        const organizer = inserted.rows[0];

        await recordAudit(client, {
            adminId: req.admin.adminId,
            action: 'create',
            entityType: 'organizer',
            entityId: organizer.id,
            changes: {
                email:       organizer.email,
                displayName: organizer.display_name,
                instagram:   organizer.instagram,
                isActive:    organizer.is_active,
                password:    'set' // never the value
            }
        });

        await client.query('COMMIT');

        // Same projection as GET, eventCount included.
        res.status(201).json({ organizer: await fetchOrganizerDetail(organizer.id) });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('POST /admin/organizers error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// GET /admin/organizers
// Lists all organizers with their event count.
adminOrganizersRouter.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT o.id, o.email, o.display_name, o.instagram, o.is_active, o.created_at,
                    COUNT(e.id) AS event_count
             FROM organizers o
             LEFT JOIN events e ON e.organizer_id = o.id
             GROUP BY o.id
             ORDER BY o.created_at ASC`
        );
        res.json({ organizers: result.rows.map(toResponse) });

    } catch (err) {
        console.error('GET /admin/organizers error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/organizers/:id
adminOrganizersRouter.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const organizer = await fetchOrganizerDetail(id);
        if (!organizer) {
            return res.status(404).json({ error: 'Organizer not found' });
        }

        res.json({ organizer });

    } catch (err) {
        console.error('GET /admin/organizers/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /admin/organizers/:id
// Partial update. A password field re-hashes and resets the organizer's
// login — this is how an admin resets a forgotten password.
adminOrganizersRouter.patch('/:id', async (req, res) => {
    const { id } = req.params;
    const { displayName, email, isActive, password, instagram } = req.body;

    if (email !== undefined && !emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }
    if (displayName !== undefined && !displayName.trim()) {
        return res.status(400).json({ error: 'displayName cannot be empty' });
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive must be a boolean' });
    }
    if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    // instagram: '' or null clears the handle; normalizeInstagram maps both
    // to null, so "unset it" and "never set it" store the same value.
    let normalizedInstagram;
    if (instagram !== undefined) {
        try {
            normalizedInstagram = normalizeInstagram(instagram);
        } catch {
            return res.status(400).json({ error: 'Invalid Instagram handle' });
        }
    }

    const client = await pool.connect();

    try {
        const beforeResult = await client.query(
            'SELECT id, email, display_name, instagram, is_active FROM organizers WHERE id = $1',
            [id]
        );
        if (beforeResult.rows.length === 0) {
            return res.status(404).json({ error: 'Organizer not found' });
        }
        const before = beforeResult.rows[0];

        const normalizedEmail = email !== undefined ? email.trim().toLowerCase() : undefined;
        if (normalizedEmail !== undefined && normalizedEmail !== before.email) {
            const dupe = await client.query(
                'SELECT id FROM organizers WHERE email = $1 AND id <> $2',
                [normalizedEmail, id]
            );
            if (dupe.rows.length > 0) {
                return res.status(409).json({ error: 'An organizer with this email already exists' });
            }
        }

        const updates = [];
        const values = [];
        let paramCount = 1;

        if (displayName !== undefined) {
            updates.push(`display_name = $${paramCount++}`);
            values.push(displayName.trim());
        }
        if (normalizedEmail !== undefined) {
            updates.push(`email = $${paramCount++}`);
            values.push(normalizedEmail);
        }
        if (isActive !== undefined) {
            updates.push(`is_active = $${paramCount++}`);
            values.push(isActive);
        }
        if (instagram !== undefined) {
            updates.push(`instagram = $${paramCount++}`);
            values.push(normalizedInstagram);
        }
        let passwordChanged = false;
        if (password !== undefined) {
            const passwordHash = await bcrypt.hash(password, 10);
            updates.push(`password_hash = $${paramCount++}`);
            values.push(passwordHash);
            passwordChanged = true;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        values.push(id);

        await client.query('BEGIN');

        const afterResult = await client.query(
            `UPDATE organizers
             SET ${updates.join(', ')}, updated_at = now()
             WHERE id = $${paramCount}
             RETURNING id, email, display_name, instagram, is_active, created_at`,
            values
        );
        const after = afterResult.rows[0];

        const changes = diffChanges(before, after, ['email', 'display_name', 'instagram', 'is_active']);
        if (passwordChanged) {
            changes.password = { from: 'set', to: 'reset' }; // never the value
        }

        if (Object.keys(changes).length > 0) {
            await recordAudit(client, {
                adminId: req.admin.adminId,
                action: 'update',
                entityType: 'organizer',
                entityId: id,
                changes
            });
        }

        await client.query('COMMIT');

        // Same projection as GET — see fetchOrganizerDetail.
        res.json({ organizer: await fetchOrganizerDetail(after.id) });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('PATCH /admin/organizers/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

export default adminOrganizersRouter;
