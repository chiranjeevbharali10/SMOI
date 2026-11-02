-- A document the user uploaded to SMOI Brain. One row per document; replacing the file
-- keeps the same row and bumps `version`.
CREATE TABLE documents (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users (id),
    filename       TEXT        NOT NULL,
    media_type     TEXT        NOT NULL,
    size_bytes     BIGINT      NOT NULL,
    -- SHA-256 of the file bytes (hex). Identical uploads by the same user are detected with it.
    content_sha256 TEXT        NOT NULL,
    -- The uploaded file. Set to NULL when the document is deleted, so the bytes don't outlive it.
    content        BYTEA,
    -- Incremented every time the file is replaced. An ingestion job only commits results
    -- for the version it was created for, so a stale job can't overwrite newer data.
    version        INT         NOT NULL DEFAULT 1,
    status         TEXT        NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued', 'processing', 'indexed', 'failed')),
    -- Why indexing failed. Only set when status = 'failed'.
    error          TEXT,
    chunk_count    INT         NOT NULL DEFAULT 0,
    indexed_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at     TIMESTAMPTZ
);

-- Idempotent upload: one active document per user per file content. Concurrent duplicate
-- uploads can't both succeed. A deleted document doesn't block uploading the file again.
CREATE UNIQUE INDEX documents_user_content_active_uk
    ON documents (user_id, content_sha256) WHERE deleted_at IS NULL;

-- Listing a user's documents, newest first.
CREATE INDEX documents_user_created_idx
    ON documents (user_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER documents_set_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
