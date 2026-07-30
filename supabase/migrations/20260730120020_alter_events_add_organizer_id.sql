-- Backfills the organizer link deferred at events table creation.
-- Nullable: existing seeded events have no organizer yet.
-- ON DELETE SET NULL: deleting an organizer must not delete their events —
-- the events remain, just unassigned, and an admin reassigns them.
ALTER TABLE events
ADD COLUMN organizer_id UUID REFERENCES organizers(id) ON DELETE SET NULL;
