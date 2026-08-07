import express from 'express';
import { pool } from '../config/db.js';
import razorpay from '../config/razorpay.js';
import authenticate from '../middlewares/auth.js';
import { validateCoupon } from '../utils/coupons.js';
import { checkRequiredHandles, socialHandlesRequiredResponse } from '../utils/socialGate.js';
import {
    getGstPercentage,
    getHoldDurationMinutes,
    calculatePrice
} from '../utils/pricing.js';
import { peopleSoldForCategory, isCategorySoldOut } from '../utils/eventCategories.js';

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
    const { eventId, couponCode, eventTicketCategoryId } = req.body;
    const userId = req.user.userId;

    if (!eventId) {
        return res.status(400).json({ error: 'Event is required' });
    }
    if (!eventTicketCategoryId) {
        return res.status(400).json({ error: 'eventTicketCategoryId is required — choose a ticket category' });
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
                    expires_at, event_ticket_category_id
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
                // The hold is per event, not per category — a user who picks a
                // different tier while holding one gets the held tier back,
                // not a second hold. They must let it expire or pay it.
                eventTicketCategoryId: o.event_ticket_category_id,
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

        // The event is read WITHOUT a lock now. Capacity is enforced per
        // category, so the lock belongs on the category row — locking the
        // event would serialize buyers of different tiers against each other
        // for no reason.
        const eventResult = await client.query(
            `SELECT id, starts_at, event_type,
                    require_facebook, require_instagram, require_linkedin
             FROM events WHERE id = $1`,
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

        // Social handle gate — the first gate, ahead of invite-acceptance and
        // capacity. A user missing a required handle can't buy at all, so
        // there's no point burning an invitation check or a seat race on them.
        //
        // Evaluated here and only here: a requirement added after someone
        // bought has no effect on their existing ticket.
        const profileForGate = await client.query(
            'SELECT facebook, instagram, linkedin FROM profiles WHERE user_id = $1',
            [userId]
        );
        const gate = checkRequiredHandles(event, profileForGate.rows[0] ?? null);
        if (!gate.ok) {
            await client.query('ROLLBACK');
            return res.status(403).json(socialHandlesRequiredResponse(gate.missing));
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

        // ── The critical section ───────────────────────────────────────
        //
        // Everything from here to COMMIT decides whether a seat exists and
        // claims it. Order matters absolutely:
        //
        //   1. lock THIS category's row (not the event, not other categories)
        //   2. compute people sold for it, UNDER that lock
        //   3. decide, then insert
        //
        // Computing the count before the lock — or on any other connection —
        // reopens the race: two buyers would both read the pre-lock count,
        // both find room, and both insert. The lock is what makes step 2 see
        // the other transaction's committed work.
        const categoryResult = await client.query(
            `SELECT id, price_paise, admits_count, ticket_quantity
             FROM event_ticket_categories
             WHERE id = $1 AND event_id = $2
             FOR UPDATE`,
            [eventTicketCategoryId, eventId]
        );

        if (categoryResult.rows.length === 0) {
            // Distinguish "this event sells nothing yet" from "you asked for a
            // category that isn't this event's" — the frontend renders a
            // different state for each.
            const anyCategories = await client.query(
                'SELECT 1 FROM event_ticket_categories WHERE event_id = $1 LIMIT 1',
                [eventId]
            );
            await client.query('ROLLBACK');

            if (anyCategories.rows.length === 0) {
                return res.status(409).json({
                    error: 'not_available_for_sale',
                    message: 'This event has no ticket categories configured yet'
                });
            }
            return res.status(404).json({ error: 'That ticket category is not available for this event' });
        }

        const category = categoryResult.rows[0];

        // A 0-quantity tier exists but has nothing to sell. Distinct from
        // unlimited (null), which is the opposite.
        if (category.ticket_quantity === 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                error: 'category_sold_out',
                message: 'This ticket category is sold out'
            });
        }

        // Room for THIS ticket's worth of people. Unlimited tiers skip the
        // check entirely — there is no number to compare against and inventing
        // a large one would be a lie waiting to overflow.
        if (category.ticket_quantity !== null) {
            const peopleSold = await peopleSoldForCategory(client, category.id);

            if (isCategorySoldOut(
                { admitsCount: category.admits_count, ticketQuantity: category.ticket_quantity },
                peopleSold
            )) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error: 'category_sold_out',
                    message: 'This ticket category is sold out'
                });
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
        // Sourced from the category, read under the FOR UPDATE above, so the
        // price frozen here is the one that was current at the moment the seat
        // was claimed. A later admin edit to that category's price cannot
        // reach this order — same guarantee as before, new source.
        const gstPercentage = await getGstPercentage();
        const breakdown = calculatePrice(
            category.price_paise,
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
                user_id, event_id, event_ticket_category_id, status,
                base_price_paise, coupon_id, discount_paise, subtotal_paise,
                gst_percentage, gst_paise, total_paise,
                razorpay_order_id, expires_at
             ) VALUES (
                $1, $2, $3, 'created',
                $4, $5, $6, $7,
                $8, $9, $10,
                $11, now() + ($12 || ' minutes')::interval
             )
             RETURNING id, expires_at`,
            [
                userId, eventId, category.id,
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