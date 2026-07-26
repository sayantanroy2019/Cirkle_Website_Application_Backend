import express from 'express';
import { pool } from '../config/db.js';
import razorpay from '../config/razorpay.js';
import authenticate from '../middlewares/auth.js';
import { validateCoupon } from '../utils/coupons.js';
import {
    getGstPercentage,
    getHoldDurationMinutes,
    calculatePrice
} from '../utils/pricing.js';

import { verifyCheckoutSignature, confirmOrderPaid } from '../utils/payments.js';

const ordersRouter = express.Router();

// POST /orders
// Claims a seat hold and creates a Razorpay order.
//
// The amount is computed server-side and never accepted from the client —
// that is what stops someone editing the request to pay Rs 1 for a Rs 500 ticket.
//
// If the user already has a live hold for this event, the existing order is
// RESUMED rather than duplicated: same Razorpay order, same frozen price.
// This is what makes the abandon-and-retry flow work, and it is why the
// partial unique index on orders never fires in normal use.
ordersRouter.post('/orders', authenticate, async (req, res) => {
    const { eventId, couponCode } = req.body;
    const userId = req.user.userId;

    if (!eventId) {
        return res.status(400).json({ error: 'Event is required' });
    }

    const client = await pool.connect();

    try {
        // ── Already holds a ticket? ────────────────────────────────────
        const existingTicket = await client.query(
            'SELECT id FROM tickets WHERE user_id = $1 AND event_id = $2',
            [userId, eventId]
        );
        if (existingTicket.rows.length > 0) {
            return res.status(409).json({ error: 'You already have a ticket to this event' });
        }

        // ── Resume an existing live hold ───────────────────────────────
        const liveHold = await client.query(
            `SELECT id, razorpay_order_id, total_paise, base_price_paise,
                    discount_paise, subtotal_paise, gst_percentage, gst_paise,
                    expires_at
             FROM orders
             WHERE user_id = $1 AND event_id = $2
               AND status = 'created' AND expires_at > now()`,
            [userId, eventId]
        );

        if (liveHold.rows.length > 0) {
            const o = liveHold.rows[0];
            return res.json({
                orderId:         o.id,
                razorpayOrderId: o.razorpay_order_id,
                razorpayKeyId:   process.env.RAZORPAY_KEY_ID,
                amount:          o.total_paise,
                currency:        'INR',
                expiresAt:       o.expires_at,
                resumed:         true,
                breakdown: {
                    basePricePaise: o.base_price_paise,
                    discountPaise:  o.discount_paise,
                    subtotalPaise:  o.subtotal_paise,
                    gstPercentage:  parseFloat(o.gst_percentage),
                    gstPaise:       o.gst_paise,
                    totalPaise:     o.total_paise
                }
            });
        }

        await client.query('BEGIN');

        // ── Lock the event row, then check availability ────────────────
        // The lock is held for milliseconds — just this check and the insert.
        // The seat is protected during payment by the hold row, not the lock.
        const eventResult = await client.query(
            'SELECT id, price, capacity, starts_at, event_type FROM events WHERE id = $1 FOR UPDATE',
            [eventId]
        );

        if (eventResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Event not found' });
        }

        const event = eventResult.rows[0];

        if (new Date(event.starts_at) < new Date()) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'This event has already started' });
        }

        // Invite-only gate: an accepted invitation is required before purchase.
        // This is the real access boundary — the frontend button is only UX.
        // Approval is permission, not a seat, so this runs BEFORE the capacity
        // check: an accepted user still races for a seat and can still sell out.
        if (event.event_type === 'invite_only') {
            const inv = await client.query(
                `SELECT status FROM event_invitations
                 WHERE user_id = $1 AND event_id = $2`,
                [userId, eventId]
            );
            const status = inv.rows.length > 0 ? inv.rows[0].status : null;
            if (status !== 'accepted') {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'An accepted invitation is required to buy a ticket to this event' });
            }
        }

        // Availability = capacity - (confirmed tickets + live holds).
        // Skipped entirely when capacity is NULL (uncapped).
        if (event.capacity !== null) {
            const taken = await client.query(
                `SELECT
                    (SELECT COUNT(*) FROM tickets WHERE event_id = $1)
                  + (SELECT COUNT(*) FROM orders
                     WHERE event_id = $1 AND status = 'created' AND expires_at > now())
                 AS taken`,
                [eventId]
            );
            if (parseInt(taken.rows[0].taken, 10) >= event.capacity) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'This event is sold out' });
            }
        }

        // ── Coupon (re-validated inside the transaction) ───────────────
        let coupon = null;
        if (couponCode) {
            const check = await validateCoupon(couponCode, eventId, userId, client);
            if (!check.valid) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: check.error });
            }
            coupon = check.coupon;
        }

        // ── Freeze the price ───────────────────────────────────────────
        const gstPercentage = await getGstPercentage();
        const breakdown = calculatePrice(
            event.price,
            coupon ? coupon.discount_flat_paise : 0,
            gstPercentage
        );

        const holdMinutes = await getHoldDurationMinutes();

        // ── Razorpay order ─────────────────────────────────────────────
        // Created before our row so a Razorpay failure leaves nothing behind.
        const rzpOrder = await razorpay.orders.create({
            amount:   breakdown.totalPaise,
            currency: 'INR',
            notes: { userId, eventId }
        });

        const inserted = await client.query(
            `INSERT INTO orders (
                user_id, event_id, status,
                base_price_paise, coupon_id, discount_paise, subtotal_paise,
                gst_percentage, gst_paise, total_paise,
                razorpay_order_id, expires_at
             ) VALUES (
                $1, $2, 'created',
                $3, $4, $5, $6,
                $7, $8, $9,
                $10, now() + ($11 || ' minutes')::interval
             )
             RETURNING id, expires_at`,
            [
                userId, eventId,
                breakdown.basePricePaise,
                coupon ? coupon.id : null,
                breakdown.discountPaise,
                breakdown.subtotalPaise,
                breakdown.gstPercentage,
                breakdown.gstPaise,
                breakdown.totalPaise,
                rzpOrder.id,
                String(holdMinutes)
            ]
        );

        await client.query('COMMIT');

        res.status(201).json({
            orderId:         inserted.rows[0].id,
            razorpayOrderId: rzpOrder.id,
            razorpayKeyId:   process.env.RAZORPAY_KEY_ID,
            amount:          breakdown.totalPaise,
            currency:        'INR',
            expiresAt:       inserted.rows[0].expires_at,
            resumed:         false,
            breakdown
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('POST /orders error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// POST /payments/orders/verify
// Fast-path confirmation, relayed by the browser after Razorpay's checkout
// handler fires. Verifies the signature, then does the same idempotent work
// the webhook does.
//
// This endpoint failing does NOT mean the payment failed — it means the relay
// failed. The frontend must fall back to polling, never show an error.
ordersRouter.post('/orders/verify', authenticate, async (req, res) => {
    const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Missing payment verification fields' });
    }

    // Signature check before any DB work — a forged callback stops here
    const validSignature = verifyCheckoutSignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
    );

    if (!validSignature) {
        console.error('Invalid checkout signature for order:', razorpay_order_id);
        return res.status(400).json({ error: 'Payment verification failed' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await confirmOrderPaid(client, {
            razorpayOrderId:   razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature
        });

        if (!result.ok) {
            await client.query('ROLLBACK');

            if (result.reason === 'order_not_found') {
                return res.status(404).json({ error: 'Order not found' });
            }
            if (result.reason === 'duplicate_ticket') {
                // Charged twice for the same event. Needs a manual refund.
                console.error('DUPLICATE TICKET — refund required. Order:', result.orderId);
                return res.status(409).json({
                    error: 'You already have a ticket to this event. Our team will process a refund.'
                });
            }
            return res.status(409).json({ error: 'This order cannot be confirmed' });
        }

        await client.query('COMMIT');

        res.json({
            success:    true,
            orderId:    result.orderId,
            bookingRef: result.bookingRef
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('POST /payments/orders/verify error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// GET /payments/orders/:id
// Order status, scoped to the owner. The frontend polls this when the verify
// relay fails, waiting for the webhook to confirm independently.
ordersRouter.get('/orders/:id', authenticate, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT o.id, o.status, o.total_paise, o.event_id,
                    t.booking_ref
             FROM orders o
             LEFT JOIN tickets t ON t.order_id = o.id
             WHERE o.id = $1 AND o.user_id = $2`,
            [id, req.user.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const o = result.rows[0];

        res.json({
            orderId:    o.id,
            status:     o.status,           // created | paid | failed | expired | refunded
            totalPaise: o.total_paise,
            eventId:    o.event_id,
            bookingRef: o.booking_ref ?? null   // present once the ticket exists
        });

    } catch (err) {
        console.error('GET /payments/orders/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});
export default ordersRouter;