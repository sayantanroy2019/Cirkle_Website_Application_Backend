-- Tickets exist ONLY for paid orders.
-- All uncertainty lives in the orders table; a row here means someone paid
-- and is going to that event. This keeps "who holds a ticket to this event"
-- (the Groups tab query) a simple lookup with no status filtering.
--
-- user_id and event_id are denormalized from orders. Unlike a counter, these
-- are immutable — a ticket's owner and event can never change, so they can't
-- drift. Worth the duplication: both are on the hottest read paths.
--
-- booking_ref is derived from the UUID rather than app-generated. Hex only
-- uses 0-9 and A-F, so the ambiguous characters (O vs 0, I vs 1) that plague
-- hand-read codes are impossible by construction. 8 chars = 4.3 billion
-- combinations; the UNIQUE constraint catches the improbable collision.
CREATE TABLE tickets (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    order_id       UUID         NOT NULL UNIQUE REFERENCES orders(id),  -- no CASCADE: financial history is immutable
    user_id        UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id       UUID         NOT NULL REFERENCES events(id) ON DELETE CASCADE,

    -- What the QR encodes and what prints beneath it: CRKL-7F3A2C9E
    booking_ref    TEXT         GENERATED ALWAYS AS
                                ('CRKL-' || upper(substring(replace(id::text, '-', '') from 1 for 8)))
                                STORED,

    -- One-time scan at the venue. NULL = not yet entered.
    -- Rescan reads this and shows "already entered" rather than granting entry.
    checked_in_at  TIMESTAMPTZ,

    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- Hard guarantee: one ticket per user per event.
    -- The partial unique index on orders makes this nearly unreachable in
    -- practice; this is the backstop. If it ever fires during payment
    -- confirmation, the webhook handler must catch it and flag the order
    -- for refund rather than leaving a double charge silently.
    UNIQUE (user_id, event_id)
);

-- Scanner lookup: redemption app scans a QR, resolves the booking ref
CREATE UNIQUE INDEX tickets_booking_ref_idx ON tickets (booking_ref);

-- Groups tab: "everyone holding a ticket to this event"
CREATE INDEX tickets_event_id_idx ON tickets (event_id);