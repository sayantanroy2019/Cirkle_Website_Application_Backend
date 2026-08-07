-- The link that makes per-category capacity and revenue computable.
--
-- BOTH tickets and orders carry it, deliberately. Capacity has always counted
-- "issued tickets + live holds", and a hold is an order row that has no ticket
-- yet — so without the column on orders there is no way to count a held seat
-- against its category, and two buyers could hold the last seat of the same
-- tier simultaneously.
--
-- Nullable at the schema level because rows predating categories exist. New
-- rows created through checkout always set it; that is enforced in the order
-- flow rather than by a NOT NULL, since backfilling the old rows is
-- impossible (they were bought when the event had one implicit tier) and the
-- old data is being wiped before launch anyway.
--
-- No cascade: an event_ticket_categories row that has been sold into must not
-- be deletable. The admin guard blocks removing such a category, and this FK
-- is the backstop if that guard is ever bypassed.
ALTER TABLE tickets
    ADD COLUMN event_ticket_category_id UUID REFERENCES event_ticket_categories(id);

ALTER TABLE orders
    ADD COLUMN event_ticket_category_id UUID REFERENCES event_ticket_categories(id);

-- Both aggregations run per category on every capacity check, inside the
-- critical section under the row lock — they need to be index lookups, not
-- scans, because their cost is held-lock time.
CREATE INDEX tickets_event_ticket_category_id_idx
    ON tickets (event_ticket_category_id);

-- Partial: only live holds are ever counted, so the index only carries them.
CREATE INDEX orders_live_hold_by_category_idx
    ON orders (event_ticket_category_id)
    WHERE status = 'created';
