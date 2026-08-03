/**
 * Normalizes an Instagram handle to the bare username we store.
 *
 * Users paste whatever they have — a full profile URL, an @-prefixed handle,
 * or the handle itself. The DB stores exactly one of those forms so the
 * frontend can build `https://instagram.com/{handle}` without guessing.
 *
 * Accepts and strips: protocol, www., instagram.com/, a leading @, any
 * trailing slash, and query strings (profile links often carry ?igsh=...).
 *
 *   'https://www.instagram.com/arijitsingh/?igsh=abc' -> 'arijitsingh'
 *   '@arijitsingh'                                    -> 'arijitsingh'
 *   '  arijitsingh '                                  -> 'arijitsingh'
 *   ''  |  '   '  |  null  |  undefined               -> null
 *
 * Returns null for anything empty, so "clear this field" and "never set it"
 * are the same stored value.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null} bare handle, or null
 * @throws {Error} INVALID_INSTAGRAM if what's left isn't a plausible handle
 */
export function normalizeInstagram(raw) {
    if (raw === null || raw === undefined) {
        return null;
    }
    if (typeof raw !== 'string') {
        throw new Error('INVALID_INSTAGRAM');
    }

    let handle = raw.trim();
    if (handle === '') {
        return null;
    }

    handle = handle
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/^instagram\.com\//i, '')
        .replace(/[?#].*$/, '')   // drop ?igsh=... tracking params
        .replace(/\/+$/, '')      // drop trailing slashes
        .replace(/^@+/, '');      // drop leading @ (after the URL strip, so
                                  // '@user' and 'instagram.com/user' converge)

    if (handle === '') {
        return null;
    }

    // Instagram's own rule: letters, digits, underscore, period; max 30.
    // Anything else is a paste accident (a whole bio, an email, a different
    // platform's URL) and is better rejected than silently stored.
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) {
        throw new Error('INVALID_INSTAGRAM');
    }

    return handle;
}
