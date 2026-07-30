-- Event gallery photos — mirrors profile_photos.
-- The single banner stays on events.banner_s3_key, separate from this table.
-- These are the up-to-5 additional images shown in the event detail page's
-- gallery section. Max 5 enforced in application logic, same pattern as
-- profile photos' 2-4 minimum/maximum.
CREATE TABLE event_photos (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id    UUID         NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    s3_key      TEXT         NOT NULL,
    position    INTEGER      NOT NULL CHECK (position >= 0 AND position <= 4),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (event_id, position)
);
