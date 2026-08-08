import express from 'express';
import { pool } from '../config/db.js';
import authenticateAdmin from '../middlewares/authenticateAdmin.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { userContactFor } from '../utils/adminPii.js';

const adminInvitationsRouter = express.Router();

const ALLOWED_STATUSES = ['pending', 'accepted', 'rejected'];

// Read-only oversight — both admin roles, no capability gate. Global view of
// all invitation activity; the organizer dashboard will later show a scoped
// (own-events-only) version of this.
adminInvitationsRouter.use(authenticateAdmin);

function toResponse(row, admin) {
    return {
        id:        row.id,
        status:    row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        event: {
            id:   row.event_id,
            name: row.event_name
        },
        organizer: row.organizer_id ? {
            id:   row.organizer_id,
            name: row.organizer_name
        } : null,
        // PII: phone included for context, role-gated via userContactFor() —
        // real for administrative, masked for BD.
        user: {
            id:        row.user_id,
            firstName: row.user_first_name,
            age:       row.user_age,
            gender:    row.user_gender,
            ...userContactFor(admin, { phone: row.user_phone })
        }
    };
}

// GET /admin/invitations
// Filterable by eventId, status, userId.
adminInvitationsRouter.get('/', async (req, res) => {
    const { eventId, status, userId } = req.query;
    const { limit, offset } = parsePagination(req.query);

    if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
    }

    const conditions = [];
    const values = [];
    let p = 1;

    if (eventId !== undefined) { conditions.push(`ei.event_id = $${p++}`); values.push(eventId); }
    if (status !== undefined)  { conditions.push(`ei.status = $${p++}`);   values.push(status); }
    if (userId !== undefined)  { conditions.push(`ei.user_id = $${p++}`);  values.push(userId); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const countResult = await pool.query(`SELECT COUNT(*) FROM event_invitations ei ${where}`, values);

        const dataResult = await pool.query(
            `SELECT
                ei.*,
                e.name AS event_name,
                org.id AS organizer_id, org.display_name AS organizer_name,
                u.phone AS user_phone,
                p.first_name AS user_first_name, p.gender AS user_gender,
                EXTRACT(YEAR FROM AGE(p.date_of_birth))::INT AS user_age
             FROM event_invitations ei
             JOIN events e ON e.id = ei.event_id
             LEFT JOIN organizers org ON org.id = ei.organizer_id
             JOIN users u ON u.id = ei.user_id
             LEFT JOIN profiles p ON p.user_id = u.id
             ${where}
             ORDER BY ei.created_at DESC, ei.id DESC
             LIMIT $${p++} OFFSET $${p++}`,
            [...values, limit, offset]
        );

        res.json(paginatedResponse(dataResult.rows.map(r => toResponse(r, req.admin)), countResult.rows[0].count, limit, offset));

    } catch (err) {
        console.error('GET /admin/invitations error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default adminInvitationsRouter;
