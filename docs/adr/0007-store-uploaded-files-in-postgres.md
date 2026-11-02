# 0007: Store uploaded files in Postgres (bytea)

- Status: Accepted
- Date: 2026-11-02

## Context

The ingestion worker needs the original file after the upload request has returned, and again when a
job is retried or a document re-indexed. The file has to live somewhere the worker can read it, and it
has to disappear when the user deletes the document (NFR-04.04).

## Decision

Store the file in `documents.content` (`BYTEA`), written in the same transaction as the document row and
its ingestion job.

- Uploads are limited to 25 MB by default (`MAX_UPLOAD_SIZE`).
- Postgres keeps large values out of line (TOAST), and every metadata query names its columns. Listing
  documents never reads the file bytes.
- Deleting a document sets `content = NULL` in the same transaction that soft-deletes it and removes its chunks.

## Alternatives rejected

- **Files on a local disk or Docker volume, with the path in the database.** Writing the file and
  committing the row can't be one transaction. A crash in between leaves an orphan file, or a row
  pointing at nothing. Backups would also need to cover two places.
- **Object storage (S3, MinIO).** Same transaction problem, plus another service to run for a
  single-user desktop app.

## Consequences

- One store, one backup, and transactional upload/delete.
- Database size grows with uploaded files. For a personal knowledge base this is fine. A multi-user
  service would move files to object storage with an outbox for consistency.
- The worker loads the whole file into memory, which the upload limit keeps bounded.
