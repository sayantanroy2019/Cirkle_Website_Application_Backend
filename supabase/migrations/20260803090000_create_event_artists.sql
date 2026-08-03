-- Event lineup — the artists performing at an event.
--
-- Deliberately event-scoped rather than a global artist catalogue: the same
-- performer at two events is two rows. A shared catalogue would need identity
-- resolution, merge handling, and a management surface nobody has asked for.
-- If a real catalogue is ever needed, these rows are the migration source.
--
-- Max 10 per event is enforced in application logic, same pattern as the
-- 5-image gallery cap. position 0 is the headliner.
CREATE TABLE event_artists (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      UUID         NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name          TEXT         NOT NULL,
    -- Bare handle only — no leading @, no instagram.com/ prefix. Normalized
    -- on write by normalizeInstagram() in src/utils/instagram.js.
    instagram     TEXT,
    -- Nullable: an artist with no photo returns photoUrl null and the
    -- frontend supplies its own default avatar.
    photo_s3_key  TEXT,
    position      INTEGER      NOT NULL CHECK (position >= 0 AND position <= 9),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- DEFERRABLE because PUT /artists updates positions in place to preserve
    -- each artist's photo key. Reordering a lineup (swapping 0 and 1) collides
    -- mid-transaction on a non-deferred constraint; deferring the check to
    -- COMMIT lets the rows pass through an inconsistent intermediate state and
    -- still guarantees uniqueness once the transaction lands.
    UNIQUE (event_id, position) DEFERRABLE INITIALLY DEFERRED
);

-- The lineup is always read by event, ordered by position.
CREATE INDEX event_artists_event_id_position_idx
    ON event_artists (event_id, position);
