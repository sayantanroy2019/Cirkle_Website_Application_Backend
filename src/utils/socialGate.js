import { SOCIAL_PLATFORMS } from './socialHandles.js';

/**
 * Checks a user's profile against an event's social handle requirements.
 *
 * The single place this rule is expressed. Both gate points — buying a ticket
 * and requesting an invitation — call this, so "what counts as missing" can
 * never drift between them.
 *
 * Evaluated at the moment of purchase or request, never stored. Adding a
 * requirement to an event therefore has no retroactive effect: tickets already
 * sold stay valid, and nobody is re-gated for a rule that didn't exist when
 * they bought.
 *
 * A handle counts as present only if it's a non-empty string. Handles are
 * normalized to null when cleared (see socialHandles.js), so in practice the
 * check is a null check — the whitespace guard is belt-and-braces against a
 * row written before normalization existed.
 *
 * @param {object} event   row with require_facebook / require_instagram / require_linkedin
 * @param {object|null} profile  row with facebook / instagram / linkedin
 * @returns {{ ok: boolean, missing: string[] }} missing is in a stable order
 */
export function checkRequiredHandles(event, profile) {
    const missing = SOCIAL_PLATFORMS.filter(platform => {
        if (!event[`require_${platform}`]) {
            return false;
        }
        const value = profile?.[platform];
        return typeof value !== 'string' || value.trim() === '';
    });

    return { ok: missing.length === 0, missing };
}

/**
 * The 403 body both gate points return. A machine-readable code plus the
 * exact list of what's missing — the frontend keys off `error` to decide
 * whether to open the handle dialog, and off `missing` to decide which fields
 * to show. Never parse the prose.
 */
export function socialHandlesRequiredResponse(missing) {
    return {
        error: 'social_handles_required',
        missing,
        message: `This event requires your ${missing.join(', ')} handle${missing.length > 1 ? 's' : ''}.`
    };
}
