import express from 'express';
import { pool } from '../config/db.js';
import authenticate from '../middlewares/auth.js';
import { validateCoupon } from '../utils/coupons.js';
import { getGstPercentage, calculatePrice } from '../utils/pricing.js';

const couponsRouter = express.Router();

// POST /coupons/validate
// Previews a coupon against an event and returns the recomputed price
// breakdown so the checkout screen can update live. Reserves nothing —
// the order endpoint re-validates independently.
couponsRouter.post('/validate', authenticate, async (req, res) => {
    const { code, eventId } = req.body;
    const userId = req.user.userId;

    if (!code || !eventId) {
        return res.status(400).json({ error: 'code and eventId are required' });
    }

    try {
        const eventResult = await pool.query(
            'SELECT id, price FROM events WHERE id = $1',
            [eventId]
        );

        if (eventResult.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const event = eventResult.rows[0];

        const check = await validateCoupon(code, eventId, userId, pool);
        if (!check.valid) {
            return res.status(400).json({ error: check.error });
        }

        const gstPercentage = await getGstPercentage();
        const breakdown = calculatePrice(
            event.price,
            check.coupon.discount_flat_paise,
            gstPercentage
        );

        res.json({
            valid: true,
            couponCode: check.coupon.code,
            breakdown
        });

    } catch (err) {
        console.error('POST /coupons/validate error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default couponsRouter;
