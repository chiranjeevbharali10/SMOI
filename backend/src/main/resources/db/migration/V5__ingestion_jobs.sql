-- The ingestion job queue. Workers claim rows with FOR UPDATE SKIP LOCKED, so Postgres is
-- the only infrastructure needed. See docs/adr/0005-postgres-job-queue.md.
CREATE TABLE ingestion_jobs (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES users (id),
    document_id      UUID        NOT NULL REFERENCES documents (id),
    -- The document version this job indexes. Results for an older version are discarded.
    document_version INT         NOT NULL,
    -- queued:    waiting for a worker (new, or waiting to retry)
    -- running:   claimed by a worker that holds the lease
    -- succeeded: chunks stored
    -- dead:      gave up; last_error says why (the dead-letter state)
    -- cancelled: the document was replaced or deleted before the job finished
    status           TEXT        NOT NULL DEFAULT 'queued'
                                 CHECK (status IN ('queued', 'running', 'succeeded', 'dead', 'cancelled')),
    -- Incremented each time a worker claims the job, including after a crash.
    attempts         INT         NOT NULL DEFAULT 0,
    max_attempts     INT         NOT NULL,
    -- Earliest time a worker may claim the job:
    --   queued:  now for a new job, or the backoff time before a retry
    --   running: when the current worker's lease expires. If the worker crashes, it stops
    --            renewing the lease, and the job becomes claimable again at this time.
    available_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Random token for the current claim. A worker can only update the job while its token
    -- matches, so a worker whose lease expired can't overwrite the job's new owner.
    lease_token      UUID,
    last_error       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ
);

-- The claim query: the oldest claimable job first.
CREATE INDEX ingestion_jobs_claimable_idx
    ON ingestion_jobs (available_at)
    WHERE status IN ('queued', 'running') AND deleted_at IS NULL;

CREATE INDEX ingestion_jobs_user_document_idx ON ingestion_jobs (user_id, document_id);

CREATE TRIGGER ingestion_jobs_set_updated_at
    BEFORE UPDATE ON ingestion_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
