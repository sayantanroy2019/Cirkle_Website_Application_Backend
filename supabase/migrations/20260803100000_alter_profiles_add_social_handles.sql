-- Self-entered social handles. OAuth verification is deliberately deferred —
-- these are typed by the user, so they prove intent, not identity.
--
-- Bare handles only: no @, no URL prefix, no trailing slash, no tracking
-- params. Normalized on write by src/utils/socialHandles.js, the same helper
-- that normalizes organizer and artist Instagram handles.
--
-- All nullable — a user may have none, and none are required to hold an
-- account. Individual events opt into requiring them (see events.require_*).
ALTER TABLE profiles
  ADD COLUMN facebook  TEXT,
  ADD COLUMN instagram TEXT,
  ADD COLUMN linkedin  TEXT;
