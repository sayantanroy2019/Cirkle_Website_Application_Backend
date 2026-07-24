-- Add per-event ticket capacity
-- NULL = uncapped (organizer set no limit)
-- Any set value must be positive — a capacity of 0 would mean an event
-- that can never sell a ticket, which is a data-entry error, not an intent
-- The "IS NULL OR" is required: without it the CHECK would reject NULL
-- and break uncapped events entirely
--
-- Deliberately no tickets_sold counter column. Availability is computed as
--   capacity - (confirmed tickets + live holds)
-- so it can never drift from reality. See create_orders.sql for the query.
ALTER TABLE events
ADD COLUMN capacity INTEGER CHECK (capacity IS NULL OR capacity > 0);