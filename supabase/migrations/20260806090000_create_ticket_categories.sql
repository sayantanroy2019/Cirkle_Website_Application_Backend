-- Global, reusable catalogue of ticket category NAMES — admin-managed
-- reference data, in the same spirit as cities and lifestyle_tags.
--
-- Names only. Price, admits-count and inventory are deliberately NOT here:
-- they vary per event, and live on event_ticket_categories. "Couple Pass"
-- is one catalogue row whether it costs 2000 at one event and 5000 at another.
--
-- Uniqueness is enforced case-insensitively via the functional index below,
-- so 'VIP' and 'vip' cannot both exist. Names are also trimmed on write.
--
-- There is no hard delete: a name may be referenced by events (and later by
-- tickets and orders). Retire it with is_active = false, which removes it from
-- the admin dropdown while leaving every existing reference intact.
CREATE TABLE ticket_categories (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    is_active   BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness. The plain UNIQUE above still catches exact
-- duplicates; this catches the ones that differ only in case.
CREATE UNIQUE INDEX ticket_categories_name_lower_key
    ON ticket_categories (lower(name));
