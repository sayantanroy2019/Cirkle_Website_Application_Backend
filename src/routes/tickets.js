import express from 'express';
import { pool } from '../config/db.js';
import authenticate from '../middlewares/auth.js';

const ticketsRouter = express.Router();

// GET /tickets
// The My Tickets list. Optional ?filter=upcoming|past (default upcoming).
// Pure logistics — no group/payment data, per the spec's decoupling rule.
ticketsRouter.get('/', authenticate, async (req, res) => {
    const { filter = 'upcoming' } = req.query;

    if (!['upcoming', 'past'].includes(filter)) {
        return res.status(400).json({ error: 'filter must be upcoming or past' });
    }

    // Upcoming = event hasn't started yet; past = already started
    const comparator = filter === 'upcoming' ? '>=' : '<';

    try {
        const result = await pool.query(
            `SELECT
                t.id,
                t.booking_ref,
                t.checked_in_at,
                e.id           AS event_id,
                e.name         AS event_name,
                e.category_id,
                e.starts_at,
                e.venue_name,
                e.venue_address,
                e.banner_s3_key
             FROM tickets t
             JOIN events e ON e.id = t.event_id
             WHERE t.user_id = $1
               AND e.starts_at ${comparator} now()
             ORDER BY e.starts_at ASC`,
            [req.user.userId]
        );

        res.json({
            tickets: result.rows.map(t => ({
                id:            t.id,
                bookingRef:    t.booking_ref,
                checkedIn:     t.checked_in_at !== null,
                event: {
                    id:           t.event_id,
                    name:         t.event_name,
                    categoryId:   t.category_id,
                    startsAt:     t.starts_at,
                    venueName:    t.venue_name,
                    venueAddress: t.venue_address,
                    bannerS3Key:  t.banner_s3_key
                }
            }))
        });

    } catch (err) {
        console.error('GET /tickets error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /tickets/:id
// Ticket Detail — the QR block + entry logistics. Scoped to the owner.
ticketsRouter.get('/:id', authenticate, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT
                t.id,
                t.booking_ref,
                t.checked_in_at,
                t.created_at   AS booked_at,
                e.id           AS event_id,
                e.name         AS event_name,
                e.category_id,
                e.starts_at,
                e.venue_name,
                e.venue_address,
                e.banner_s3_key,
                o.total_paise
             FROM tickets t
             JOIN events e ON e.id = t.event_id
             JOIN orders o ON o.id = t.order_id
             WHERE t.id = $1 AND t.user_id = $2`,
            [id, req.user.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        const t = result.rows[0];

        res.json({
            ticket: {
                id:          t.id,
                bookingRef:  t.booking_ref,     // this is what the QR encodes
                checkedIn:   t.checked_in_at !== null,
                pricePaid:   t.total_paise,
                bookedAt:    t.booked_at,
                event: {
                    id:           t.event_id,
                    name:         t.event_name,
                    categoryId:   t.category_id,
                    startsAt:     t.starts_at,
                    venueName:    t.venue_name,
                    venueAddress: t.venue_address,
                    bannerS3Key:  t.banner_s3_key
                }
            }
        });

    } catch (err) {
        console.error('GET /tickets/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default ticketsRouter;