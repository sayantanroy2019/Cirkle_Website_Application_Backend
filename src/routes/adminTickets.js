import express from 'express';
import { pool } from '../config/db.js';
import authenticateAdmin from '../middlewares/authenticateAdmin.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

const adminTicketsRouter = express.Router();

// Read-only oversight — both admin roles, no capability gate.
adminTicketsRouter.use(authenticateAdmin);

function toResponse(row) {
    return {
        id:          row.id,
        bookingRef:  row.booking_ref,
        checkedIn:   row.checked_in_at !== null,
        checkedInAt: row.checked_in_at,
        createdAt:   row.created_at,
        event: {
            id:      row.event_id,
            name:    row.event_name,
            startsAt: row.event_starts_at
        },
        // PII: phone included for support lookup — see the PII note in
        // adminUsers.js. Deliberate, un-masked for now.
        user: {
            id:        row.user_id,
            firstName: row.user_first_name,
            phone:     row.user_phone
        }
    };
}

// GET /admin/tickets
// Filterable by eventId, checkedIn (true/false), userId. Filtered by eventId
// alone, this is effectively the venue guest list for that event.
adminTicketsRouter.get('/', async (req, res) => {
    const { eventId, checkedIn, userId } = req.query;
    const { limit, offset } = parsePagination(req.query);

    if (checkedIn !== undefined && checkedIn !== 'true' && checkedIn !== 'false') {
        return res.status(400).json({ error: 'checkedIn must be true or false' });
    }

    const conditions = [];
    const values = [];
    let p = 1;

    if (eventId !== undefined) { conditions.push(`t.event_id = $${p++}`); values.push(eventId); }
    if (userId !== undefined)  { conditions.push(`t.user_id = $${p++}`);  values.push(userId); }
    if (checkedIn === 'true')  { conditions.push('t.checked_in_at IS NOT NULL'); }
    if (checkedIn === 'false') { conditions.push('t.checked_in_at IS NULL'); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const countResult = await pool.query(`SELECT COUNT(*) FROM tickets t ${where}`, values);

        const dataResult = await pool.query(
            `SELECT t.*, e.name AS event_name, e.starts_at AS event_starts_at,
                    u.phone AS user_phone, p.first_name AS user_first_name
             FROM tickets t
             JOIN events e ON e.id = t.event_id
             JOIN users u ON u.id = t.user_id
             LEFT JOIN profiles p ON p.user_id = u.id
             ${where}
             ORDER BY t.created_at DESC, t.id DESC
             LIMIT $${p++} OFFSET $${p++}`,
            [...values, limit, offset]
        );

        res.json(paginatedResponse(dataResult.rows.map(toResponse), countResult.rows[0].count, limit, offset));

    } catch (err) {
        console.error('GET /admin/tickets error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/tickets/:id
// Single ticket detail — plus which order it came from and price paid.
adminTicketsRouter.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT t.*, e.name AS event_name, e.starts_at AS event_starts_at,
                    u.phone AS user_phone, p.first_name AS user_first_name,
                    o.id AS order_id, o.total_paise AS price_paid_paise
             FROM tickets t
             JOIN events e ON e.id = t.event_id
             JOIN users u ON u.id = t.user_id
             LEFT JOIN profiles p ON p.user_id = u.id
             JOIN orders o ON o.id = t.order_id
             WHERE t.id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        const row = result.rows[0];

        res.json({
            ticket: {
                ...toResponse(row),
                order: {
                    id:           row.order_id,
                    pricePaidPaise: row.price_paid_paise
                }
            }
        });

    } catch (err) {
        console.error('GET /admin/tickets/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default adminTicketsRouter;
