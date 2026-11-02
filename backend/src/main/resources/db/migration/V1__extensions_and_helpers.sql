-- pgvector powers semantic search from Phase 2 onwards. Enabling it now proves
-- the database image is right from day one.
CREATE EXTENSION IF NOT EXISTS vector;

-- Shared trigger function: keeps updated_at correct on every UPDATE, so
-- application code can't forget it. Each user-owned table attaches it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
