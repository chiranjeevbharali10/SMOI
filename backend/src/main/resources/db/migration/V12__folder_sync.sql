-- Folder sync (docs/adr/0019-folder-sync.md). The desktop app watches folders on the user's
-- machine and sends changed files here; SMOI never writes to or deletes anything on disk.

-- A folder the user asked SMOI to keep indexed. `path` is as the desktop app reports it.
CREATE TABLE folders (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users (id),
    path       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX folders_user_path_active_uk ON folders (user_id, path) WHERE deleted_at IS NULL;

CREATE TRIGGER folders_set_updated_at
    BEFORE UPDATE ON folders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One file inside a watched folder. `modified_time` and `size_bytes` are the desktop's quick
-- check: only a file whose pair changed is hashed again. `content_hash` is the SHA-256 of the
-- bytes, used to tell a rename or move (same hash) from an edit (new hash).
CREATE TABLE folder_files (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users (id),
    folder_id     UUID        NOT NULL REFERENCES folders (id),
    path          TEXT        NOT NULL,
    -- NULL when the file could not be read or sent (status failed, error says why).
    content_hash  TEXT,
    modified_time TIMESTAMPTZ NOT NULL,
    size_bytes    BIGINT      NOT NULL,
    -- pending:   sent, waiting to be indexed
    -- done:      indexed
    -- failed:    could not be read, sent or indexed (error says why)
    -- needs_ocr: a PDF with little or no extractable text; indexed once OCR is turned on
    status        TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'done', 'failed', 'needs_ocr')),
    error         TEXT,
    -- The indexed document. Two files with identical content share one document.
    document_id   UUID        REFERENCES documents (id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX folder_files_user_path_active_uk ON folder_files (user_id, path) WHERE deleted_at IS NULL;
CREATE INDEX folder_files_user_folder_idx ON folder_files (user_id, folder_id) WHERE deleted_at IS NULL;
CREATE INDEX folder_files_user_document_idx ON folder_files (user_id, document_id) WHERE deleted_at IS NULL;

CREATE TRIGGER folder_files_set_updated_at
    BEFORE UPDATE ON folder_files
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Where a document came from. Folder sync only ever deletes documents it created itself, so a
-- file the user uploaded by hand survives even if a watched folder held the same content.
ALTER TABLE documents ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload', 'folder'));

-- Folder jobs run after uploads: lower numbers are claimed first.
ALTER TABLE ingestion_jobs ADD COLUMN priority INT NOT NULL DEFAULT 0;
DROP INDEX ingestion_jobs_claimable_idx;
CREATE INDEX ingestion_jobs_claimable_idx
    ON ingestion_jobs (priority, available_at)
    WHERE status IN ('queued', 'running') AND deleted_at IS NULL;
