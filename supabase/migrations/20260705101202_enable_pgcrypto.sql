-- Enable UUID generation
-- gen_random_uuid() is used as the default for all UUID primary keys
CREATE EXTENSION IF NOT EXISTS pgcrypto;