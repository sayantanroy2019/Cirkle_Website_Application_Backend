-- Per-event social handle requirements. An event can demand that attendees
-- have supplied particular handles before they buy a ticket or request an
-- invitation — the organizer then sees those handles on the attendee card.
--
-- DEFAULT false so existing events require nothing. The gate is evaluated at
-- the moment of purchase or invitation request, never retroactively: adding a
-- requirement to an event does not invalidate tickets already sold.
ALTER TABLE events
  ADD COLUMN require_facebook  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN require_instagram BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN require_linkedin  BOOLEAN NOT NULL DEFAULT false;
