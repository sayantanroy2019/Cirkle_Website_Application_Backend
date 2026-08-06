-- Let a tier be explicitly unlimited.
--
-- ticket_quantity semantics from here on:
--   NULL   -> unlimited; checkout skips the capacity check for this tier (Part 4)
--   0      -> the tier exists but has nothing to sell (sold out / not yet stocked)
--   N > 0  -> capped; people-capacity = admits_count * N
--
-- NULL and 0 are deliberately different states. Collapsing them would make
-- "unlimited" indistinguishable from "sold out", which are opposites.
ALTER TABLE event_ticket_categories
    ALTER COLUMN ticket_quantity DROP NOT NULL;

ALTER TABLE event_ticket_categories
    DROP CONSTRAINT event_ticket_categories_ticket_quantity_check;

ALTER TABLE event_ticket_categories
    ADD CONSTRAINT event_ticket_categories_ticket_quantity_check
    CHECK (ticket_quantity IS NULL OR ticket_quantity >= 0);
