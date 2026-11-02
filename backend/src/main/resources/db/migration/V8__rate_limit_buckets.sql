-- Per-user token buckets for rate limiting (docs/adr/0011). One row per user and bucket
-- (query, search, upload). Kept in Postgres rather than in memory so that every backend instance
-- enforces the same limit (NFR-06.01).
CREATE TABLE rate_limit_buckets (
    id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID             NOT NULL REFERENCES users (id),
    bucket      TEXT             NOT NULL,
    -- Tokens left after the last request, and when that was. Refill is computed from the elapsed
    -- time on the next request, so no background job is needed.
    tokens      DOUBLE PRECISION NOT NULL,
    refilled_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
    -- Whether the last request was let through (set by the same statement that took the token).
    allowed     BOOLEAN          NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX rate_limit_buckets_user_bucket_idx
    ON rate_limit_buckets (user_id, bucket)
    WHERE deleted_at IS NULL;

CREATE TRIGGER rate_limit_buckets_set_updated_at
    BEFORE UPDATE ON rate_limit_buckets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
