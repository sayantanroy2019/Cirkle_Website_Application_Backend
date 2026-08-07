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
    const { code, eventId, eventTicketCategoryId } = req.body;
    const userId = req.user.userId;

    if (!code || !eventId) {
        return res.status(400).json({ error: 'code and eventId are required' });
    }
    // The preview has to discount the same base the charge will, and that base
    // is now per category — without knowing the tier there is no price to
    // preview against.
    if (!eventTicketCategoryId) {
        return res.status(400).json({ error: 'eventTicketCategoryId is required — choose a ticket category first' });
    }

    try {
        // Price comes from the chosen category, scoped to the event so a
        // category id from another event can't be used to preview a cheaper
        // tier against this one.
        const categoryResult = await pool.query(
            `SELECT price_paise FROM event_ticket_categories
             WHERE id = $1 AND event_id = $2`,
            [eventTicketCategoryId, eventId]
        );

        if (categoryResult.rows.length === 0) {
            return res.status(404).json({ error: 'That ticket category is not available for this event' });
        }

        const check = await validateCoupon(code, eventId, userId, pool);
        if (!check.valid) {
            return res.status(400).json({ error: check.error });
        }

        const gstPercentage = await getGstPercentage();
        const breakdown = calculatePrice(
            categoryResult.rows[0].price_paise,
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
