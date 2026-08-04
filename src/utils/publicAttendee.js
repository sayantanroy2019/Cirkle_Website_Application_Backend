import { pool } from '../config/db.js';
import { getPhotoViewUrls } from './s3.js';

/**
 * The ONLY place consumer-facing attendee profile data is fetched from the DB.
 *
 * Deliberately NOT organizerAttendee.js's fetchAttendeeProfiles(). That helper
 * selects last_name, bio, facebook, instagram and linkedin — the social
 * handles being a considered widening for organizers, who need them when
 * deciding on an invitation request. None of that is appropriate for a roster
 * any logged-in user can open, so this is a separate query with a narrower
 * column list rather than a shared one that filters afterwards.
 *
 * Same guarantee, enforced the same way: what isn't SELECTed cannot leak, so a
 * bug in the response builder still can't expose a column that was never
 * fetched. The two paths are kept separate precisely so each can be audited on
 * its own — the duplicated photo/tag loading below is the deliberate price of
 * that, and is not sensitive in either direction.
 *
 * Returned card is exactly the shape /vibes returns for a person, so the two
 * cannot drift: { id, firstName, age, gender, tagline, photos, lifestyleTags }.
 *
 * @param {string[]} userIds
 * @returns {Promise<Record<string, object>>} userId -> public profile card
 */
export async function fetchPublicAttendeeProfiles(userIds) {
    if (userIds.length === 0) {
        return {};
    }

    const profilesResult = await pool.query(
        `SELECT
            user_id, first_name, gender, tagline,
            -- Age only, computed in SQL. date_of_birth itself is never
            -- selected, so it cannot reach a response by any route.
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
    // Bucket is private — sign every key across every card in one batch.
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
            id:            row.user_id,
            firstName:     row.first_name,
            age:           row.age,
            gender:        row.gender,
            tagline:       row.tagline,
            photos:        photosByUser[row.user_id] ?? [],
            lifestyleTags: tagsByUser[row.user_id] ?? []
        };
    }
    return profiles;
}
