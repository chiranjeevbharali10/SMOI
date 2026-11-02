-- The request that created an ingestion job, so a job's log lines can be matched to the upload
-- that caused it (NFR-07.04). Only an opaque id; never content.
ALTER TABLE ingestion_jobs ADD COLUMN request_id TEXT;
