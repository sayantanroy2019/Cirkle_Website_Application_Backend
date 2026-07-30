/**
 * Writes one audit_log row inside the caller's open transaction — if the
 * mutation rolls back, so does its audit row. No orphan entries for changes
 * that didn't actually happen.
 *
 * Security: never pass password_hash or a plaintext password in `changes`.
 * When auditing organizer/admin creation or password resets, record that a
 * password was set, never its value.
 *
 * @param {object} client   pg client with a transaction already begun
 * @param {{ adminId: string, action: string, entityType: string, entityId: string, changes?: object }} entry
 */
export async function recordAudit(client, { adminId, action, entityType, entityId, changes }) {
    await client.query(
        `INSERT INTO audit_log (admin_id, action, entity_type, entity_id, changes)
         VALUES ($1, $2, $3, $4, $5)`,
        [adminId, action, entityType, entityId, changes ? JSON.stringify(changes) : null]
    );
}

/**
 * Computes a shallow diff between two snapshots of the same row, for audit
 * logging on updates. Only fields that actually changed are included.
 *
 * @param {object} before  row before the update (snake_case DB columns)
 * @param {object} after   row after the update (same shape)
 * @param {string[]} fields  which columns to compare
 * @returns {object} { field: { from, to } } — empty object if nothing changed
 */
export function diffChanges(before, after, fields) {
    const changes = {};
    for (const field of fields) {
        const from = before[field];
        const to = after[field];
        // JSON.stringify comparison catches value differences (including
        // Date vs Date, via their ISO serialization) without a deep-equal dep.
        if (JSON.stringify(from) !== JSON.stringify(to)) {
            changes[field] = { from, to };
        }
    }
    return changes;
}
