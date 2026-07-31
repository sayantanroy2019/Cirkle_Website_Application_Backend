import { pool } from '../config/db.js';
import { getPhotoViewUrls } from './s3.js';

/**
 * The ONLY place organizer-facing attendee/requester profile data is
 * fetched from the DB. Used by both GET /organizer/events/:id/attendees
 * and GET /organizer/events/:id/invitations — one code path, so there is
 * exactly one place to audit for PII exposure.
 *
 * Deliberately never selects users.phone or profiles.email — the SQL query
 * itself is incapable of leaking them, not just the response serializer.
 * This is the "select only what's allowed at the query level" guarantee:
 * even a bug in the code building the response can't leak a column that
 * was never fetched in the first place.
 *
 * @param {string[]} userIds
 * @returns {Promise<Record<string, object>>} userId -> profile card (no phone/email)
 */
export async function fetchAttendeeProfiles(userIds) {
    if (userIds.length === 0) {
        return {};
    }

    const profilesResult = await pool.query(
        `SELECT
            user_id, first_name, last_name, gender, bio, tagline,
            EXTRACT(YEAR FROM AGE(date_of_birth))::INT AS age
         FROM profiles
         WHERE user_id = ANY($1::uuid[])`,
        [userIds]
    );

    const photosResult = await pool.query(
        `SELECT user_id, s3_key, position
         FROM profile_photos
         WHERE user_id = ANY($1::uuid[])
         ORDER BY position ASC`,
        [userIds]
    );
    const viewUrls = await getPhotoViewUrls(photosResult.rows.map(p => p.s3_key));
    const photosByUser = {};
    for (const row of photosResult.rows) {
        (photosByUser[row.user_id] ??= []).push({ url: viewUrls[row.s3_key], position: row.position });
    }

    const tagsResult = await pool.query(
        `SELECT plt.user_id, lt.label, lt.category
         FROM profile_lifestyle_tags plt
         JOIN lifestyle_tags lt ON lt.id = plt.lifestyle_tag_id
         WHERE plt.user_id = ANY($1::uuid[])`,
        [userIds]
    );
    const tagsByUser = {};
    for (const row of tagsResult.rows) {
        (tagsByUser[row.user_id] ??= []).push({ label: row.label, category: row.category });
    }

    const profiles = {};
    for (const row of profilesResult.rows) {
        profiles[row.user_id] = {
            userId:        row.user_id,
            firstName:     row.first_name,
            lastName:      row.last_name,
            age:           row.age,
            gender:        row.gender,
            bio:           row.bio,
            tagline:       row.tagline,
            photos:        photosByUser[row.user_id] ?? [],
            lifestyleTags: tagsByUser[row.user_id] ?? []
        };
    }
    return profiles;
}
