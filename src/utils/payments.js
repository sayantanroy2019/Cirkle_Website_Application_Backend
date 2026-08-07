import crypto from 'crypto';

/**
 * Constant-time string comparison. A plain === leaks timing information
 * that can be used to forge a signature byte by byte.
 */
function safeCompare(a, b) {
    const bufA = Buffer.from(a || '', 'utf8');
    const bufB = Buffer.from(b || '', 'utf8');
    if (bufA.length !== bufB.length) return false;   // timingSafeEqual throws on length mismatch
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies the signature returned by Razorpay Checkout to the client.
 * Payload is `${orderId}|${paymentId}`, signed with the API key secret.
 *
 * NOTE: this is a DIFFERENT secret and a DIFFERENT payload from the webhook
 * signature. Treating them as interchangeable is a common and costly bug.
 */
export function verifyCheckoutSignature(razorpayOrderId, razorpayPaymentId, signature) {
    const expected = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');
    return safeCompare(expected, signature);
}

/**
 * Verifies a Razorpay webhook. Signed over the RAW request body with the
 * webhook secret — the body must not be parsed or re-stringified before this,
 * since JSON.stringify does not guarantee byte-identical output.
 */
export function verifyWebhookSignature(rawBody, signature) {
    const expected = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');
    return safeCompare(expected, signature);
}

/**
 * Marks an order paid, creates the ticket, records the coupon redemption.
 * Idempotent: called by both the client callback and the webhook, in either
 * order, any number of times.
 *
 * Must be called inside an open transaction — it takes a row lock on the
 * order, which is the one place in this codebase where two genuinely
 * concurrent requests can hit the same row within milliseconds.
 *
 * @param {object} client  pg client with a transaction already begun
 * @returns {{ ok, alreadyProcessed?, orderId?, bookingRef?, reason? }}
 */
export async function confirmOrderPaid(client, {
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature = null,
    paymentMethod = null,
    paymentMethodDetail = null
}) {
    const orderResult = await client.query(
        `SELECT id, user_id, event_id, event_ticket_category_id,
                status, coupon_id, discount_paise
         FROM orders
         WHERE razorpay_order_id = $1
         FOR UPDATE`,
        [razorpayOrderId]
    );

    if (orderResult.rows.length === 0) {
        return { ok: false, reason: 'order_not_found' };
    }

    const order = orderResult.rows[0];

    // Already confirmed by the other path — return the existing ticket, change nothing
    if (order.status === 'paid') {
        const existing = await client.query(
            'SELECT booking_ref FROM tickets WHERE order_id = $1',
            [order.id]
        );
        return {
            ok: true,
            alreadyProcessed: true,
            orderId: order.id,
            bookingRef: existing.rows[0]?.booking_ref ?? null
        };
    }

    // Anything other than 'created' cannot become paid
    if (order.status !== 'created') {
        return { ok: false, reason: 'invalid_status', status: order.status };
    }

    // Deliberately NOT checking expires_at. If Razorpay took the money, the
    // user gets a ticket — full stop. An expired hold only stops counting
    // toward availability; it never invalidates a completed payment.

    await client.query(
        `UPDATE orders
         SET status = 'paid',
             razorpay_payment_id   = $1,
             razorpay_signature    = $2,
             payment_method        = $3,
             payment_method_detail = $4,
             updated_at            = now()
         WHERE id = $5`,
        [razorpayPaymentId, razorpaySignature, paymentMethod, paymentMethodDetail, order.id]
    );

    let bookingRef;
    try {
        // The ticket inherits the order's category, so the seat that was held
        // and the seat that is issued are always the same tier. Carrying it on
        // both rows is what lets capacity count holds and tickets together.
        const ticket = await client.query(
            `INSERT INTO tickets (order_id, user_id, event_id, event_ticket_category_id)
             VALUES ($1, $2, $3, $4)
             RETURNING booking_ref`,
            [order.id, order.user_id, order.event_id, order.event_ticket_category_id]
        );
        bookingRef = ticket.rows[0].booking_ref;
    } catch (err) {
        // 23505 = unique_violation. Means UNIQUE(user_id, event_id) fired:
        // this user already holds a ticket to this event, so they have been
        // charged twice. Surface it rather than silently swallowing — the
        // caller flags it for a manual refund.
        if (err.code === '23505') {
            return { ok: false, reason: 'duplicate_ticket', orderId: order.id };
        }
        throw err;
    }

    // Redemption recorded only on success, and only if a discount actually applied.
    // ON CONFLICT guards the case where a retried webhook races the client callback.
    if (order.coupon_id && order.discount_paise > 0) {
        await client.query(
            `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id, discount_applied_paise)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (order_id) DO NOTHING`,
            [order.coupon_id, order.user_id, order.id, order.discount_paise]
        );
    }

    return { ok: true, alreadyProcessed: false, orderId: order.id, bookingRef };
}