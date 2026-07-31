const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Parses limit/offset from a query string, clamping to sane bounds.
 * limit: default 50, max 100. offset: default 0, never negative.
 */
export function parsePagination(query) {
    let limit = parseInt(query.limit, 10);
    if (!Number.isInteger(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    let offset = parseInt(query.offset, 10);
    if (!Number.isInteger(offset) || offset < 0) offset = 0;

    return { limit, offset };
}

/**
 * Standard list-endpoint envelope: { data, total, limit, offset }.
 * `total` is a COUNT(*) over the same filter, without limit/offset, so the
 * frontend can render "showing X-Y of Z" and page controls.
 */
export function paginatedResponse(data, total, limit, offset) {
    return { data, total: parseInt(total, 10), limit, offset };
}
