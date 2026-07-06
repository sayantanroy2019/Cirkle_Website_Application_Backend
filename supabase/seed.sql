-- ============================================================
-- SEED DATA — static reference rows
-- Applied once against the dev database
-- Safe to re-run: INSERT ... ON CONFLICT DO NOTHING
-- ============================================================

-- ------------------------------------------------------------
-- Cities (Phase 1 launch cities)
-- ------------------------------------------------------------
INSERT INTO cities (id, name) VALUES
    ('del', 'Delhi NCR'),
    ('mum', 'Mumbai'),
    ('blr', 'Bangalore'),
    ('hyd', 'Hyderabad'),
    ('che', 'Chennai'),
    ('kol', 'Kolkata')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- Event categories
-- ------------------------------------------------------------
INSERT INTO event_categories (id, label) VALUES
    ('club',    'Clubs'),
    ('concert', 'Concerts'),
    ('trip',    'Trips'),
    ('meetup',  'Meetups')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- Lifestyle tags
-- ------------------------------------------------------------
INSERT INTO lifestyle_tags (label, category) VALUES
    -- Going out
    ('Clubbing',        'Going out'),
    ('Bar hopping',     'Going out'),
    ('Live music',      'Going out'),

    -- Active & outdoors
    ('Gym',             'Active & outdoors'),
    ('Hiking',          'Active & outdoors'),
    ('Swimming',        'Active & outdoors'),

    -- Travel & experiences
    ('Travelling',      'Travel & experiences'),
    ('Road trips',      'Travel & experiences'),

    -- Arts & culture
    ('Art & design',    'Arts & culture'),
    ('Theatre',         'Arts & culture'),

    -- Social & community
    ('Meetups',         'Social & community'),
    ('Networking',      'Social & community')
ON CONFLICT (label) DO NOTHING;

-- ------------------------------------------------------------
-- Sample events (Phase 1 manual seed — Delhi NCR only)
-- ------------------------------------------------------------
INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, venue_name, venue_address, description) VALUES
    (
        'Sunidhi Chauhan Live',
        'concert',
        'del',
        '2026-08-14 19:00:00+05:30',
        50000,
        4,
        'Jawaharlal Nehru Stadium',
        'Lodhi Road, New Delhi',
        'An unforgettable evening with Bollywood''s queen of melody.'
    ),
    (
        'Saturday Night at Kitty Su',
        'club',
        'del',
        '2026-08-16 22:00:00+05:30',
        80000,
        3,
        'Kitty Su',
        'The Lalit, Barakhamba Road, New Delhi',
        'Delhi''s most iconic club night. Resident DJs + special guests.'
    ),
    (
        'Spiti Valley Weekend Trip',
        'trip',
        'del',
        '2026-08-22 06:00:00+05:30',
        350000,
        6,
        'Departure: Kashmiri Gate ISBT',
        'Kashmiri Gate, New Delhi',
        'A 3-day curated trip through the stunning Spiti Valley.'
    ),
    (
        'Delhi Tech Mixer',
        'meetup',
        'del',
        '2026-08-10 18:30:00+05:30',
        20000,
        5,
        'WeWork Baani Square',
        'Sector 50, Gurugram',
        'Builders, founders, and operators — come connect over drinks.'
    )
ON CONFLICT DO NOTHING;