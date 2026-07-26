-- Per-user, per-event permission to buy a ticket to an invite-only event.
-- Approval is PERMISSION, not a seat: this table never touches capacity.
-- An accepted user still races everyone at checkout, first-come-first-paid.
--
-- Lifecycle is strictly one-directional:
--   (no row) -> pending -> accepted   (terminal, cannot be revoked)
--                       -> rejected   (terminal, cannot be appealed)
-- Once a row leaves 'pending' it never changes again.
--
-- UNIQUE(user_id, event_id) enforces the whole rule set at the DB level:
--   no duplicate requests, no re-request after rejection, no second request
--   after acceptance. One invitation per user per event, forever.
CREATE TABLE event_invitations (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id    UUID         NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    status      TEXT         NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','accepted','rejected')),
    -- organizer_id (who approved) deferred with the organizer side
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (user_id, event_id)
);

-- The buy-button gate and the order-creation check both look up
-- "this user's invitation for this event" — covered by the UNIQUE index above.
-- This second index serves the organizer's future "pending requests for my event" query.
CREATE INDEX event_invitations_event_status_idx
    ON event_invitations (event_id, status);