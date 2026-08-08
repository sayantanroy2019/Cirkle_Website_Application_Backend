import express from 'express';
import { pool } from '../config/db.js';
import authenticateAdmin from '../middlewares/authenticateAdmin.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

const adminOrdersRouter = express.Router();

const ALLOWED_STATUSES = ['created', 'paid', 'failed', 'expired', 'refunded'];

// 'YYYY-MM-DD' with no time component — the form that means "a whole day".
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Rejects junk before it reaches Postgres, where a bad cast would surface as
// a 500 rather than a 400.
function isValidDateInput(value) {
    return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

// Read-only oversight — both admin roles, no capability gate.
adminOrdersRouter.use(authenticateAdmin);

function toResponse(row) {
    return {
        id:     row.id,
        status: row.status,
        breakdown: {
            basePricePaise: row.base_price_paise,
            discountPaise:  row.discount_paise,
            subtotalPaise:  row.subtotal_paise,
            gstPercentage:  parseFloat(row.gst_percentage),
            gstPaise:       row.gst_paise,
            totalPaise:     row.total_paise
        },
        paymentMethod:       row.payment_method,
        paymentMethodDetail: row.payment_method_detail,
        razorpayOrderId:     row.razorpay_order_id,
        razorpayPaymentId:   row.razorpay_payment_id,
        createdAt:           row.created_at,
        event: {
            id:   row.event_id,
            name: row.event_name
        },
        // PII: phone is included here for support lookup, per spec. See the
        // note in adminUsers.js — this is a deliberate, un-masked exposure
        // for now; a future view_pii capability will gate this server-side.
        user: {
            id:        row.user_id,
            firstName: row.user_first_name,
            phone:     row.user_phone
        }
    };
}

// GET /admin/orders
// Filterable by status, eventId, userId, and a created_at date range.
adminOrdersRouter.get('/', async (req, res) => {
    const { status, eventId, userId, from, to } = req.query;
    const { limit, offset } = parsePagination(req.query);

    if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
    }

    const conditions = [];
    const values = [];
    let p = 1;

    if (status !== undefined)  { conditions.push(`o.status = $${p++}`);       values.push(status); }
    if (eventId !== undefined) { conditions.push(`o.event_id = $${p++}`);     values.push(eventId); }
    if (userId !== undefined)  { conditions.push(`o.user_id = $${p++}`);      values.push(userId); }
    // Date bounds.
    //
    // A bare date means the whole of that DAY, in UTC. created_at is
    // timestamptz and the DB session runs in UTC, so 'YYYY-MM-DD' casts to
    // midnight UTC — `from` is already start-of-day inclusive and needs no
    // special handling.
    //
    // `to` did need it: compared directly, a bare 'to' meant midnight at the
    // START of that day, so everything created during the day fell outside
    // the bound and from=X&to=X returned nothing. Swagger documented `to` as
    // inclusive, so this was a contract violation, not a quirk.
    //
    // The fix is half-open — created_at < to + 1 day — which is exact for
    // timestamps of any precision, unlike comparing against 23:59:59.999.
    //
    // A `to` carrying an explicit time is honoured as given: callers wanting
    // an IST business day (as the admin portal already sends) pass full UTC
    // instants and are unaffected.
    if (from !== undefined) {
        if (!isValidDateInput(from)) {
            return res.status(400).json({ error: 'from must be YYYY-MM-DD or an ISO 8601 timestamp' });
        }
        conditions.push(`o.created_at >= $${p++}`);
        values.push(from);
    }
    if (to !== undefined) {
        if (!isValidDateInput(to)) {
            return res.status(400).json({ error: 'to must be YYYY-MM-DD or an ISO 8601 timestamp' });
        }
        if (BARE_DATE.test(to)) {
            conditions.push(`o.created_at < ($${p++}::date + interval '1 day')`);
        } else {
            conditions.push(`o.created_at <= $${p++}`);
        }
        values.push(to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const countResult = await pool.query(`SELECT COUNT(*) FROM orders o ${where}`, values);

        const dataResult = await pool.query(
            `SELECT o.*, e.name AS event_name, u.phone AS user_phone, p.first_name AS user_first_name
             FROM orders o
             JOIN events e ON e.id = o.event_id
             JOIN users u ON u.id = o.user_id
             LEFT JOIN profiles p ON p.user_id = u.id
             ${where}
             ORDER BY o.created_at DESC, o.id DESC
             LIMIT $${p++} OFFSET $${p++}`,
            [...values, limit, offset]
        );

        res.json(paginatedResponse(dataResult.rows.map(toResponse), countResult.rows[0].count, limit, offset));

    } catch (err) {
        console.error('GET /admin/orders error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/orders/:id
// Full single order — breakdown, event, user, plus the coupon used (if any)
// and the linked ticket (if paid).
adminOrdersRouter.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT o.*, e.name AS event_name, u.phone AS user_phone, p.first_name AS user_first_name
             FROM orders o
             JOIN events e ON e.id = o.event_id
             JOIN users u ON u.id = o.user_id
             LEFT JOIN profiles p ON p.user_id = u.id
             WHERE o.id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const row = result.rows[0];

        let coupon = null;
        if (row.coupon_id) {
            const c = await pool.query(
                'SELECT id, code, discount_flat_paise FROM coupons WHERE id = $1',
                [row.coupon_id]
            );
            if (c.rows.length > 0) {
                coupon = {
                    id:                c.rows[0].id,
                    code:              c.rows[0].code,
                    discountFlatPaise: c.rows[0].discount_flat_paise
                };
            }
        }

        const t = await pool.query(
            'SELECT id, booking_ref, checked_in_at FROM tickets WHERE order_id = $1',
            [id]
        );
        const ticket = t.rows.length > 0 ? {
            id:         t.rows[0].id,
            bookingRef: t.rows[0].booking_ref,
            checkedIn:  t.rows[0].checked_in_at !== null
        } : null;

        res.json({ order: { ...toResponse(row), coupon, ticket } });

    } catch (err) {
        console.error('GET /admin/orders/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default adminOrdersRouter;
