-- Event access type
-- 'open'        = anyone can buy immediately (default; every existing event)
-- 'invite_only' = user needs an accepted invitation before the buy button appears
-- DEFAULT 'open' so all existing rows are unaffected by this migration.
ALTER TABLE events
ADD COLUMN event_type TEXT NOT NULL DEFAULT 'open'
    CHECK (event_type IN ('open','invite_only'));