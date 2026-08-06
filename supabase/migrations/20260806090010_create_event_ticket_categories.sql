-- Per-event configuration of a catalogue category: what this event charges
-- for it, how many people one such ticket admits, and how many exist.
--
-- One booking is still one ticket = one QR. admits_count is what that single
-- ticket lets through the door: Single Pass = 1, Couple Pass = 2, Group of 4
-- = 4. Users buy exactly one ticket of one category, never several.
--
-- ticket_quantity is inventory in TICKETS, which is what the admin types.
-- People-capacity for a category is admits_count * ticket_quantity, and the
-- event's total capacity is that summed across its categories — both derived
-- on read, never stored. (Part 4 rewires the code that still reads the
-- vestigial events.capacity / events.price columns.)
CREATE TABLE event_ticket_categories (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id          UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    -- No cascade on this FK, deliberately: a catalogue name that is in use
    -- must not be deletable. Retiring is is_active = false on the catalogue.
    category_id       UUID        NOT NULL REFERENCES ticket_categories(id),
    price_paise       INTEGER     NOT NULL,
    admits_count      INTEGER     NOT NULL,
    ticket_quantity   INTEGER     NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- An event lists each catalogue category at most once.
    UNIQUE (event_id, category_id),
    CHECK (admits_count >= 1),
    CHECK (ticket_quantity >= 0),
    CHECK (price_paise >= 0)
);

-- Categories are always read by event.
CREATE INDEX event_ticket_categories_event_id_idx
    ON event_ticket_categories (event_id);
