import express from 'express';
import { pool } from '../config/db.js';
import { verifyWebhookSignature, confirmOrderPaid } from '../utils/payments.js';

const webhookRouter = express.Router();

// POST /webhooks/razorpay
// Authoritative, server-to-server confirmation. Arrives regardless of what
// happened to the user's browser. Razorpay retries on any non-200, so this
// must be idempotent and must return 200 quickly even when it no-ops.
webhookRouter.post('/razorpay', async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];

    // req.rawBody is the Buffer captured in app.js
    if (!signature || !req.rawBody) {
        return res.status(400).json({ error: 'Missing signature or body' });
    }

    if (!verifyWebhookSignature(req.rawBody, signature)) {
        console.error('Invalid webhook signature');
        return res.status(400).json({ error: 'Invalid signature' });
    }

    // Safe to parse only after the signature is verified
    let event;
    try {
        event = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    // We only act on successful payment capture. Everything else is acknowledged
    // with 200 so Razorpay stops retrying, but ignored.
    if (event.event !== 'payment.captured') {
        return res.status(200).json({ received: true });
    }

    const payment = event.payload?.payment?.entity;
    if (!payment?.order_id) {
        return res.status(200).json({ received: true });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await confirmOrderPaid(client, {
            razorpayOrderId:     payment.order_id,
            razorpayPaymentId:   payment.id,
            paymentMethod:       payment.method ?? null,
            paymentMethodDetail: extractMethodDetail(payment)
        });

        if (!result.ok) {
            // order_not_found or duplicate_ticket. Roll back, but still 200 —
            // retrying won't help, and we don't want Razorpay hammering us.
            await client.query('ROLLBACK');
            if (result.reason === 'duplicate_ticket') {
                console.error('WEBHOOK duplicate ticket — refund required. Order:', result.orderId);
            } else {
                console.error('WEBHOOK could not confirm:', result.reason, payment.order_id);
            }
            return res.status(200).json({ received: true });
        }

        await client.query('COMMIT');
        return res.status(200).json({ received: true });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Webhook processing error:', err.message);
        // 500 here → Razorpay retries later. Correct: a transient DB error
        // is exactly the case where a retry should succeed.
        return res.status(500).json({ error: 'Processing failed' });
    } finally {
        client.release();
    }
});

// Builds the human-readable payment method detail from Razorpay's payment object
function extractMethodDetail(payment) {
    switch (payment.method) {
        case 'card':
            return payment.card
                ? `${payment.card.network ?? 'Card'} ${payment.card.last4 ?? ''}`.trim()
                : 'Card';
        case 'upi':
            return payment.vpa ?? 'UPI';
        case 'netbanking':
            return payment.bank ?? 'Netbanking';
        case 'wallet':
            return payment.wallet ?? 'Wallet';
        default:
            return null;
    }
}

export default webhookRouter;