import { can } from './permissions.js';

/**
 * Role-based masking of END-USER contact details for admin-facing responses.
 *
 * The rule: administrative admins hold view_pii and see real values;
 * business_development admins do not and see masked ones. It is a hard mask —
 * there is no reveal endpoint, no query flag, no way back to the real value
 * through the API. A BD admin who genuinely needs a number escalates to an
 * administrative admin out of band.
 *
 * MASK ON THE SERVER, ALWAYS. The masked string is what leaves the process;
 * the real value never enters the response body. Sending the real value and
 * hiding it in the client would leave it sitting in the network tab, which
 * defeats the entire point.
 *
 * Scope: this is about END-USER PII shown to admins. It deliberately does not
 * touch staff identities (admin and organizer login emails), the user's own
 * view of their own profile, or organizer-facing attendee data — that last one
 * has no phone or email in its SQL at all, which is a stronger guarantee than
 * masking and is left exactly as it is.
 */

/**
 * '+919876543210' -> '+91******210'
 *
 * Keeps the country code and the last three digits: enough for an admin to
 * confirm "yes, that's the user I'm looking at" without handing over a number
 * they could actually dial. The masked run is a FIXED six asterisks rather
 * than one per hidden digit, so the output doesn't leak how long the number is.
 */
export function maskPhone(phone) {
    if (typeof phone !== 'string' || phone.trim() === '') {
        return phone ?? null;
    }

    const trimmed = phone.trim();
    const digits = trimmed.replace(/\D/g, '');

    // Too short to mask meaningfully — hide it entirely rather than leak most
    // of a short number.
    if (digits.length < 5) {
        return '******';
    }

    const countryCode = trimmed.startsWith('+') ? trimmed.slice(0, 3) : '';
    const last = digits.slice(-3);
    return `${countryCode}******${last}`;
}

/**
 * 'jane.doe@gmail.com' -> 'j****@gmail.com'
 *
 * The domain stays visible: it is far less sensitive than the local part, and
 * it gives useful context (a work address vs a personal one) when an admin is
 * checking they have the right person. The local part is reduced to its first
 * character with a fixed-length mask, so the length of the real one isn't
 * leaked either.
 */
export function maskEmail(email) {
    if (typeof email !== 'string' || email.trim() === '') {
        return email ?? null;
    }

    const trimmed = email.trim();
    const at = trimmed.lastIndexOf('@');

    // Not an address shape — mask the whole thing rather than guess.
    if (at <= 0) {
        return '****';
    }

    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at);   // includes the '@'
    return `${local[0]}****${domain}`;
}

/**
 * THE decision point. Every admin-facing response carrying a user's phone or
 * email goes through this, so the rule lives in one place.
 *
 * @param {{role: string}} admin  req.admin — the requesting admin
 * @param {{phone?: string|null, email?: string|null}} contact
 * @returns {{phone?: string|null, email?: string|null}} real or masked
 */
export function userContactFor(admin, { phone, email } = {}) {
    const allowed = can(admin, 'view_pii');

    const out = {};
    if (phone !== undefined) {
        out.phone = allowed ? phone : maskPhone(phone);
    }
    if (email !== undefined) {
        out.email = allowed ? email : maskEmail(email);
    }
    return out;
}
