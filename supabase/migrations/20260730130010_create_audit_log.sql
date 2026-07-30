-- Admin action audit trail. Every mutation an admin makes (create/update/
-- deactivate on organizers, events, admins, ...) writes one row here, inside
-- the same transaction as the mutation — see src/utils/audit.js. If the
-- mutation rolls back, so does its audit row; no orphan entries for changes
-- that didn't actually happen.
--
-- admin_id has no CASCADE — audit history must survive even if an admin is
-- later deleted (accounts get deactivated, not deleted, but this is the
-- correct FK behavior regardless).
--
-- changes is JSONB: the full object for creates, or { field: { from, to } }
-- for updates — only fields that actually changed. Never contains
-- password_hash or plaintext passwords.
CREATE TABLE audit_log (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id     UUID         NOT NULL REFERENCES admins(id),
    action       TEXT         NOT NULL,        -- 'create' | 'update' | 'deactivate' | etc.
    entity_type  TEXT         NOT NULL,        -- 'event' | 'organizer' | 'admin' | ...
    entity_id    UUID         NOT NULL,        -- which entity
    changes      JSONB,                        -- { field: { from, to } } for updates; full object for creates
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- "History of this entity"
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
-- "Everything this admin did"
CREATE INDEX audit_log_admin_idx  ON audit_log (admin_id, created_at);
