-- Organizer's public Instagram handle, shown as an icon link on the consumer
-- event-detail page. Optional — nullable, no backfill.
--
-- Bare handle only (no leading @, no instagram.com/ prefix), same rule and
-- same normalizeInstagram() helper as event_artists.instagram.
ALTER TABLE organizers ADD COLUMN instagram TEXT;
