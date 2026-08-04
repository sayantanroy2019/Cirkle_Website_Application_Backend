/**
 * Normalizes self-entered social handles to the bare username we store.
 *
 * Users paste whatever they have — a full profile URL, an @-prefixed handle,
 * or the handle itself. The DB stores exactly one form so the frontend can
 * build a link without guessing, and so the organizer sees a handle rather
 * than someone's clipboard contents.
 *
 * These are typed by the user, not verified by OAuth (deferred). Normalization
 * therefore proves shape, never identity — a syntactically perfect handle may
 * still point at an account the user doesn't own.
 */

/** Strips the parts every platform's pasted URL has in common. */
function stripUrlNoise(raw, hostPattern) {
    return raw
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(hostPattern, '')
        .replace(/[?#].*$/, '')   // tracking params: ?igsh=, ?originalSubdomain=
        .replace(/\/+$/, '')      // trailing slashes
        .replace(/^@+/, '');      // leading @ (after host strip, so '@x' and
                                  // 'instagram.com/x' converge)
}

/**
 * Shared shape for all three normalizers.
 *
 * @param {string|null|undefined} raw
 * @param {RegExp} hostPattern  leading host+path to remove
 * @param {RegExp} valid        what a bare handle may look like
 * @returns {string|null} bare handle, or null when empty
 * @throws {Error} INVALID_HANDLE when what remains isn't a plausible handle
 */
function normalize(raw, hostPattern, valid) {
    if (raw === null || raw === undefined) {
        return null;
    }
    if (typeof raw !== 'string') {
        throw new Error('INVALID_HANDLE');
    }
    if (raw.trim() === '') {
        return null;
    }

    const handle = stripUrlNoise(raw, hostPattern);

    // Empty after stripping — e.g. someone pasted the bare domain.
    if (handle === '') {
        return null;
    }
    if (!valid.test(handle)) {
        throw new Error('INVALID_HANDLE');
    }
    return handle;
}

/**
 * Instagram: letters, digits, underscore, period; max 30 (Instagram's own rule).
 *   'https://www.instagram.com/arijitsingh/?igsh=abc' -> 'arijitsingh'
 *   '@arijitsingh'                                    -> 'arijitsingh'
 */
export function normalizeInstagram(raw) {
    return normalize(raw, /^instagram\.com\//i, /^[A-Za-z0-9._]{1,30}$/);
}

/**
 * Facebook: letters, digits, period; max 50. Also accepts fb.com and the
 * numeric profile.php?id= form, which normalizes to the bare id.
 *   'https://facebook.com/zuck'              -> 'zuck'
 *   'facebook.com/profile.php?id=1234567890' -> '1234567890'
 */
export function normalizeFacebook(raw) {
    if (typeof raw === 'string') {
        // profile.php?id=N — the query string carries the identity, so pull it
        // out before the generic stripper discards everything after '?'.
        const numeric = raw.match(/facebook\.com\/profile\.php\?id=(\d+)/i);
        if (numeric) {
            return numeric[1];
        }
    }
    return normalize(raw, /^(facebook\.com|fb\.com)\//i, /^[A-Za-z0-9.]{1,50}$/);
}

/**
 * LinkedIn: vanity slugs allow letters, digits and hyphens; max 100.
 * Strips the /in/ path segment that every personal profile URL carries.
 *   'https://www.linkedin.com/in/sayantan-roy/?originalSubdomain=in'
 *       -> 'sayantan-roy'
 */
export function normalizeLinkedin(raw) {
    return normalize(raw, /^linkedin\.com\/(in\/)?/i, /^[A-Za-z0-9\-]{1,100}$/);
}

/**
 * Keyed by the platform names used throughout the API and the DB columns, so
 * callers can normalize a whole payload without a switch.
 */
export const HANDLE_NORMALIZERS = {
    facebook:  normalizeFacebook,
    instagram: normalizeInstagram,
    linkedin:  normalizeLinkedin
};

export const SOCIAL_PLATFORMS = Object.keys(HANDLE_NORMALIZERS);
