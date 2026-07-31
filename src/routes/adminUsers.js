import express from 'express';
import { pool } from '../config/db.js';
import authenticateAdmin from '../middlewares/authenticateAdmin.js';
import { getPhotoViewUrls } from '../utils/s3.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

const adminUsersRouter = express.Router();

// Read-only oversight — both admin roles, no capability gate.
adminUsersRouter.use(authenticateAdmin);

// ── PII ──────────────────────────────────────────────────────────────────
// phone and email are sensitive PII. They are returned in full to every
// admin for now (no masking implemented in this part). All raw exposure of
// these two fields is funneled through the two functions below — when a
// view_pii capability is added later, masking gets added in exactly these
// two places, not scattered across every route in this file.
function serializeUserSummary(row) {
    return {
        id:          row.id,
        firstName:   row.first_name,
        lastName:    row.last_name,
        age:         row.age,
        gender:      row.gender,
        cityId:      row.city_id,
        phone:       row.phone,  // PII
        email:       row.email,  // PII
        createdAt:   row.created_at,
        ticketCount: parseInt(row.ticket_count, 10),
        orderCount:  parseInt(row.order_count, 10)
    };
}

function serializeUserDetail(row, { photos, lifestyleTags }) {
    return {
        id:        row.id,
        firstName: row.first_name,
        lastName:  row.last_name,
        age:       row.age,
        gender:    row.gender,
        cityId:    row.city_id,
        phone:     row.phone,  // PII
        email:     row.email,  // PII
        bio:       row.bio,
        tagline:   row.tagline,
        photos,
        lifestyleTags,
        createdAt: row.created_at
    };
}
// ── end PII-sensitive block ─────────────────────────────────────────────

// GET /admin/users
// search matches phone, email, first/last name — case-insensitive partial.
adminUsersRouter.get('/', async (req, res) => {
    const { search } = req.query;
    const { limit, offset } = parsePagination(req.query);

    const conditions = [];
    const values = [];
    let p = 1;

    if (search !== undefined && search.trim() !== '') {
        conditions.push(`(
            u.phone ILIKE $${p} OR
            p.email ILIKE $${p} OR
            p.first_name ILIKE $${p} OR
            p.last_name ILIKE $${p}
        )`);
        values.push(`%${search.trim()}%`);
        p++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const countResult = await pool.query(
            `SELECT COUNT(*) FROM users u LEFT JOIN profiles p ON p.user_id = u.id ${where}`,
            values
        );

        const dataResult = await pool.query(
            `SELECT
                u.id, u.phone, u.created_at,
                p.first_name, p.last_name, p.gender, p.city_id, p.email,
                EXTRACT(YEAR FROM AGE(p.date_of_birth))::INT AS age,
                (SELECT COUNT(*) FROM tickets t WHERE t.user_id = u.id) AS ticket_count,
                (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
             FROM users u
             LEFT JOIN profiles p ON p.user_id = u.id
             ${where}
             ORDER BY u.created_at DESC
             LIMIT $${p++} OFFSET $${p++}`,
            [...values, limit, offset]
        );

        res.json(paginatedResponse(dataResult.rows.map(serializeUserSummary), countResult.rows[0].count, limit, offset));

    } catch (err) {
        console.error('GET /admin/users error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/users/:id
// The support-lookup screen: full profile (presigned photo URLs, tags,
// bio), plus order and ticket history.
adminUsersRouter.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const userResult = await pool.query(
            `SELECT
                u.id, u.phone, u.created_at,
                p.first_name, p.last_name, p.gender, p.city_id, p.email, p.bio, p.tagline,
                EXTRACT(YEAR FROM AGE(p.date_of_birth))::INT AS age
             FROM users u
             LEFT JOIN profiles p ON p.user_id = u.id
             WHERE u.id = $1`,
            [id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const row = userResult.rows[0];

        const photosResult = await pool.query(
            'SELECT id, s3_key, position FROM profile_photos WHERE user_id = $1 ORDER BY position ASC',
            [id]
        );
        const viewUrls = await getPhotoViewUrls(photosResult.rows.map(ph => ph.s3_key));
        const photos = photosResult.rows.map(ph => ({
            id:       ph.id,
            url:      viewUrls[ph.s3_key],
            position: ph.position
        }));

        const tagsResult = await pool.query(
            `SELECT lt.id, lt.label, lt.category
             FROM lifestyle_tags lt
             JOIN profile_lifestyle_tags plt ON plt.lifestyle_tag_id = lt.id
             WHERE plt.user_id = $1
             ORDER BY lt.category`,
            [id]
        );

        const ordersResult = await pool.query(
            `SELECT o.id, o.status, o.total_paise, o.created_at, e.name AS event_name
             FROM orders o
             JOIN events e ON e.id = o.event_id
             WHERE o.user_id = $1
             ORDER BY o.created_at DESC`,
            [id]
        );

        const ticketsResult = await pool.query(
            `SELECT t.id, t.booking_ref, t.checked_in_at, t.created_at, e.name AS event_name, e.starts_at
             FROM tickets t
             JOIN events e ON e.id = t.event_id
             WHERE t.user_id = $1
             ORDER BY t.created_at DESC`,
            [id]
        );

        res.json({
            user: {
                ...serializeUserDetail(row, {
                    photos,
                    lifestyleTags: tagsResult.rows.map(t => ({ id: t.id, label: t.label, category: t.category }))
                }),
                orders: ordersResult.rows.map(o => ({
                    id:         o.id,
                    status:     o.status,
                    totalPaise: o.total_paise,
                    createdAt:  o.created_at,
                    eventName:  o.event_name
                })),
                tickets: ticketsResult.rows.map(t => ({
                    id:          t.id,
                    bookingRef:  t.booking_ref,
                    checkedIn:   t.checked_in_at !== null,
                    createdAt:   t.created_at,
                    eventName:   t.event_name,
                    eventStartsAt: t.starts_at
                }))
            }
        });

    } catch (err) {
        console.error('GET /admin/users/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default adminUsersRouter;
