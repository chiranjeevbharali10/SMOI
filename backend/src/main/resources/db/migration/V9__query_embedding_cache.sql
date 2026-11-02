-- Per-user cache of query embeddings (docs/adr/0011, measured in docs/performance.md). Embedding a
-- query is the slowest retrieval stage on a CPU-only machine; asking the same question again (for
-- example re-running a search, or the desktop app retrying) can reuse the vector.
--
-- Scoped per user so the cache can't reveal whether another user asked the same question (a hit is
-- faster than a miss). The question text itself is not stored, only its SHA-256.
CREATE TABLE query_embedding_cache (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users (id),
    embedding_model TEXT        NOT NULL,
    query_sha256    TEXT        NOT NULL,
    embedding       vector(768) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX query_embedding_cache_key_idx
    ON query_embedding_cache (user_id, embedding_model, query_sha256)
    WHERE deleted_at IS NULL;

-- For expiring a user's old entries.
CREATE INDEX query_embedding_cache_user_created_idx ON query_embedding_cache (user_id, created_at);

CREATE TRIGGER query_embedding_cache_set_updated_at
    BEFORE UPDATE ON query_embedding_cache
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
