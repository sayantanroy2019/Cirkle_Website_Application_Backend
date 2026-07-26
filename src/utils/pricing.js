import { pool } from '../config/db.js';

/**
 * Reads the current GST percentage from app_settings.
 * Returned as a number (e.g. 18.00), to be snapshotted onto the order.
 */
export async function getGstPercentage() {
    const result = await pool.query(
        `SELECT value FROM app_settings WHERE key = 'gst_percentage'`
    );
    if (result.rows.length === 0) {
        throw new Error('gst_percentage missing from app_settings');
    }
    const gst = parseFloat(result.rows[0].value);
    if (isNaN(gst) || gst < 0 || gst > 100) {
        throw new Error(`Invalid gst_percentage in app_settings: ${result.rows[0].value}`);
    }
    return gst;
}

/**
 * Reads the checkout hold duration from app_settings.
 * Returned as an integer number of minutes.
 */
export async function getHoldDurationMinutes() {
    const result = await pool.query(
        `SELECT value FROM app_settings WHERE key = 'hold_duration_minutes'`
    );
    if (result.rows.length === 0) {
        throw new Error('hold_duration_minutes missing from app_settings');
    }
    const minutes = parseInt(result.rows[0].value, 10);
    if (isNaN(minutes) || minutes < 1) {
        throw new Error(`Invalid hold_duration_minutes in app_settings: ${result.rows[0].value}`);
    }
    return minutes;
}

/**
 * Computes the full price breakdown for an order.
 * All amounts in paise. GST is applied to the POST-discount subtotal.
 *
 * Discount is clamped to the base price so a large flat coupon on a cheap
 * ticket can never produce a negative subtotal.
 *
 * @param {number} basePricePaise    event price in paise
 * @param {number} discountFlatPaise coupon face value, 0 if no coupon
 * @param {number} gstPercentage     rate to apply, snapshotted by the caller
 * @returns {{ basePricePaise, discountPaise, subtotalPaise, gstPercentage, gstPaise, totalPaise }}
 */
export function calculatePrice(basePricePaise, discountFlatPaise, gstPercentage) {
    // Clamp: never discount more than the ticket costs
    const discountPaise = Math.min(discountFlatPaise || 0, basePricePaise);

    const subtotalPaise = basePricePaise - discountPaise;

    // GST on the discounted amount, rounded to the nearest paisa
    const gstPaise = Math.round(subtotalPaise * (gstPercentage / 100));

    const totalPaise = subtotalPaise + gstPaise;

    return {
        basePricePaise,
        discountPaise,
        subtotalPaise,
        gstPercentage,
        gstPaise,
        totalPaise
    };
}