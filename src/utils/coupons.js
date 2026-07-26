import { pool } from '../config/db.js';

/**
 * Validates a coupon for a given user and event.
 * Used by both the preview endpoint and order creation, so the two can
 * never disagree.
 *
 * Usage limits count confirmed redemptions PLUS live holds that reference
 * the coupon. That gives approximate reservation — 600 people can't all be
 * mid-checkout with the last 50 codes — without leaking uses on abandonment,
 * since an expired hold stops counting automatically.
 *
 * @param {string} code     raw code from the client
 * @param {string} eventId  event the coupon is being applied to
 * @param {string} userId   the logged-in user
 * @param {object} client   optional pg client, so callers can run this
 *                          inside an existing transaction
 * @returns {{ valid: boolean, error: string|null, coupon: object|null }}
 */
export async function validateCoupon(code, eventId, userId, client = pool) {
    if (!code || typeof code !== 'string') {
        return { valid: false, error: 'Invalid coupon code', coupon: null };
    }

    const normalized = code.trim().toUpperCase();

    const result = await client.query(
        `SELECT id, code, discount_flat_paise, valid_from, valid_until,
                usage_limit_total, usage_limit_per_user, event_id, is_active
         FROM coupons
         WHERE code = $1`,
        [normalized]
    );

    if (result.rows.length === 0) {
        return { valid: false, error: 'Invalid coupon code', coupon: null };
    }

    const coupon = result.rows[0];

    if (!coupon.is_active) {
        return { valid: false, error: 'This coupon is no longer available', coupon: null };
    }

    const now = new Date();

    if (new Date(coupon.valid_from) > now) {
        return { valid: false, error: 'This coupon is not yet active', coupon: null };
    }

    if (coupon.valid_until && new Date(coupon.valid_until) < now) {
        return { valid: false, error: 'This coupon has expired', coupon: null };
    }

    // Event-scoped coupon used on the wrong event
    if (coupon.event_id && coupon.event_id !== eventId) {
        return { valid: false, error: 'This coupon is not valid for this event', coupon: null };
    }

    // Total usage cap: confirmed redemptions + live holds
    if (coupon.usage_limit_total !== null) {
        const totalUsed = await client.query(
            `SELECT
                (SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id = $1)
              + (SELECT COUNT(*) FROM orders
                 WHERE coupon_id = $1 AND status = 'created' AND expires_at > now())
             AS used`,
            [coupon.id]
        );
        if (parseInt(totalUsed.rows[0].used, 10) >= coupon.usage_limit_total) {
            return { valid: false, error: 'This coupon has reached its usage limit', coupon: null };
        }
    }

    // Per-user cap: same counting approach, scoped to this user
    const userUsed = await client.query(
        `SELECT
            (SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2)
          + (SELECT COUNT(*) FROM orders
             WHERE coupon_id = $1 AND user_id = $2 AND status = 'created' AND expires_at > now())
         AS used`,
        [coupon.id, userId]
    );
    if (parseInt(userUsed.rows[0].used, 10) >= coupon.usage_limit_per_user) {
        return { valid: false, error: 'You have already used this coupon', coupon: null };
    }

    return { valid: true, error: null, coupon };
}