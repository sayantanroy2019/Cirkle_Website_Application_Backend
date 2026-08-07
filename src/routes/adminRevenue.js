import express from 'express';
import { pool } from '../config/db.js';
import authenticateAdmin from '../middlewares/authenticateAdmin.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

const adminRevenueRouter = express.Router();

// Read-only oversight — both admin roles, no capability gate.
adminRevenueRouter.use(authenticateAdmin);

// GET /admin/revenue
// Aggregate money view, computed only from status='paid' orders — never
// created/failed/expired. Refunded orders are deliberately excluded from
// the collected totals and surfaced separately as refundedPaise, so the
// numbers read as "collected X, refunded Y" rather than a netted figure
// that hides both.
adminRevenueRouter.get('/', async (req, res) => {
    try {
        const paid = await pool.query(
            `SELECT
                COALESCE(SUM(base_price_paise), 0) AS gross_paise,
                COALESCE(SUM(discount_paise), 0)   AS discounts_paise,
                COALESCE(SUM(subtotal_paise), 0)   AS net_before_gst_paise,
                COALESCE(SUM(gst_paise), 0)        AS gst_collected_paise,
                COALESCE(SUM(total_paise), 0)      AS total_collected_paise,
                COUNT(*)                           AS paid_order_count
             FROM orders WHERE status = 'paid'`
        );

        const refunded = await pool.query(
            `SELECT COALESCE(SUM(total_paise), 0) AS refunded_paise
             FROM orders WHERE status = 'refunded'`
        );

        const tickets = await pool.query('SELECT COUNT(*) AS tickets_sold FROM tickets');

        const row = paid.rows[0];

        res.json({
            grossPaise:         parseInt(row.gross_paise, 10),
            discountsPaise:      parseInt(row.discounts_paise, 10),
            netBeforeGstPaise:   parseInt(row.net_before_gst_paise, 10),
            gstCollectedPaise:   parseInt(row.gst_collected_paise, 10),
            totalCollectedPaise: parseInt(row.total_collected_paise, 10),
            paidOrderCount:      parseInt(row.paid_order_count, 10),
            ticketsSold:         parseInt(tickets.rows[0].tickets_sold, 10),
            refundedPaise:       parseInt(refunded.rows[0].refunded_paise, 10)
        });

    } catch (err) {
        console.error('GET /admin/revenue error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/revenue/by-event
// Same breakdown grouped per event — "how is each event performing."
// Paginated: an organizer/admin may have many events.
adminRevenueRouter.get('/by-event', async (req, res) => {
    const { limit, offset } = parsePagination(req.query);

    try {
        const countResult = await pool.query('SELECT COUNT(*) FROM events');

        const dataResult = await pool.query(
            `SELECT
                e.id, e.name, e.starts_at,
                COALESCE(SUM(o.base_price_paise) FILTER (WHERE o.status = 'paid'), 0) AS gross_paise,
                COALESCE(SUM(o.discount_paise)   FILTER (WHERE o.status = 'paid'), 0) AS discounts_paise,
                COALESCE(SUM(o.subtotal_paise)   FILTER (WHERE o.status = 'paid'), 0) AS net_before_gst_paise,
                COALESCE(SUM(o.gst_paise)        FILTER (WHERE o.status = 'paid'), 0) AS gst_collected_paise,
                COALESCE(SUM(o.total_paise)      FILTER (WHERE o.status = 'paid'), 0) AS total_collected_paise,
                COUNT(o.id)                      FILTER (WHERE o.status = 'paid')      AS paid_order_count,
                COALESCE(SUM(o.total_paise)      FILTER (WHERE o.status = 'refunded'), 0) AS refunded_paise,
                (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id) AS tickets_sold
             FROM events e
             LEFT JOIN orders o ON o.event_id = e.id
             GROUP BY e.id
             ORDER BY e.starts_at DESC, e.id DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        const data = dataResult.rows.map(row => ({
            eventId:             row.id,
            eventName:           row.name,
            eventStartsAt:       row.starts_at,
            grossPaise:          parseInt(row.gross_paise, 10),
            discountsPaise:      parseInt(row.discounts_paise, 10),
            netBeforeGstPaise:   parseInt(row.net_before_gst_paise, 10),
            gstCollectedPaise:   parseInt(row.gst_collected_paise, 10),
            totalCollectedPaise: parseInt(row.total_collected_paise, 10),
            paidOrderCount:      parseInt(row.paid_order_count, 10),
            ticketsSold:         parseInt(row.tickets_sold, 10),
            refundedPaise:       parseInt(row.refunded_paise, 10)
        }));

        res.json(paginatedResponse(data, countResult.rows[0].count, limit, offset));

    } catch (err) {
        console.error('GET /admin/revenue/by-event error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/revenue/by-category?eventId=
// Same breakdown grouped per ticket category — "which tier actually sells."
//
// Money still comes from the frozen order columns, never from the category's
// current price_paise: an admin repricing a tier must not restate history.
// peopleAdmitted multiplies ticket count by the tier's admits_count, which is
// the number that matters at the door.
adminRevenueRouter.get('/by-category', async (req, res) => {
    const { eventId } = req.query;
    const { limit, offset } = parsePagination(req.query);

    try {
        const filter = eventId ? 'WHERE etc.event_id = $1' : '';
        const filterValues = eventId ? [eventId] : [];

        const countResult = await pool.query(
            `SELECT COUNT(*) FROM event_ticket_categories etc ${filter}`,
            filterValues
        );

        const dataResult = await pool.query(
            `SELECT
                etc.id, etc.event_id, etc.admits_count, etc.price_paise,
                e.name AS event_name,
                tc.name AS category_name,
                COALESCE(SUM(o.base_price_paise) FILTER (WHERE o.status = 'paid'), 0) AS gross_paise,
                COALESCE(SUM(o.discount_paise)   FILTER (WHERE o.status = 'paid'), 0) AS discounts_paise,
                COALESCE(SUM(o.subtotal_paise)   FILTER (WHERE o.status = 'paid'), 0) AS net_before_gst_paise,
                COALESCE(SUM(o.gst_paise)        FILTER (WHERE o.status = 'paid'), 0) AS gst_collected_paise,
                COALESCE(SUM(o.total_paise)      FILTER (WHERE o.status = 'paid'), 0) AS total_collected_paise,
                COUNT(o.id)                      FILTER (WHERE o.status = 'paid')      AS paid_order_count,
                COALESCE(SUM(o.total_paise)      FILTER (WHERE o.status = 'refunded'), 0) AS refunded_paise,
                (SELECT COUNT(*) FROM tickets t WHERE t.event_ticket_category_id = etc.id) AS tickets_sold
             FROM event_ticket_categories etc
             JOIN events e ON e.id = etc.event_id
             JOIN ticket_categories tc ON tc.id = etc.category_id
             LEFT JOIN orders o ON o.event_ticket_category_id = etc.id
             ${filter}
             GROUP BY etc.id, e.name, tc.name
             ORDER BY e.name ASC, etc.price_paise ASC, etc.id ASC
             LIMIT $${filterValues.length + 1} OFFSET $${filterValues.length + 2}`,
            [...filterValues, limit, offset]
        );

        const data = dataResult.rows.map(row => {
            const ticketsSold = parseInt(row.tickets_sold, 10);
            return {
                eventTicketCategoryId: row.id,
                eventId:             row.event_id,
                eventName:           row.event_name,
                categoryName:        row.category_name,
                admitsCount:         row.admits_count,
                currentPricePaise:   row.price_paise,
                ticketsSold,
                peopleAdmitted:      ticketsSold * row.admits_count,
                grossPaise:          parseInt(row.gross_paise, 10),
                discountsPaise:      parseInt(row.discounts_paise, 10),
                netBeforeGstPaise:   parseInt(row.net_before_gst_paise, 10),
                gstCollectedPaise:   parseInt(row.gst_collected_paise, 10),
                totalCollectedPaise: parseInt(row.total_collected_paise, 10),
                paidOrderCount:      parseInt(row.paid_order_count, 10),
                refundedPaise:       parseInt(row.refunded_paise, 10)
            };
        });

        res.json(paginatedResponse(data, countResult.rows[0].count, limit, offset));

    } catch (err) {
        console.error('GET /admin/revenue/by-category error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default adminRevenueRouter;
