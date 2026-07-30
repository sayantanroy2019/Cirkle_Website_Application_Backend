-- Access control: an organizer may only approve/reject invitations for
-- their own events. Populated from the event's organizer_id whenever an
-- invitation is created.
ALTER TABLE event_invitations
ADD COLUMN organizer_id UUID REFERENCES organizers(id) ON DELETE SET NULL;

-- One-time backfill for existing rows, keyed off their event's organizer.
-- A no-op today (no event has an organizer assigned yet) — self-updating
-- once Part 2 assigns organizers to events.
UPDATE event_invitations ei
SET organizer_id = e.organizer_id
FROM events e
WHERE e.id = ei.event_id
  AND ei.organizer_id IS NULL
  AND e.organizer_id IS NOT NULL;
