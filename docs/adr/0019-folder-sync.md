# 0019: Folder sync, needs-OCR and the optional OCR sidecar

- Status: Accepted
- Date: 2026-11-06

## Context

The brain upgrade (`docs/brain-upgrade-plan.md`, Phase 3) asks SMOI to keep whole folders on the
user's machine indexed: add and remove several folders, notice new, edited, renamed, moved and
deleted files while running, catch up on changes made while SMOI was closed, index in a low-priority
background queue that survives a crash, flag scanned PDFs, and show progress such as "142 of 300
indexed, 3 failed". Documents must never leave the machine.

The original brief assumed a Python app with SQLite and watchdog. SMOI's backend is Java with
Postgres (CLAUDE.md), and it runs in Docker, which can't see the user's folders without bind mounts.

## Decisions

1. **The desktop app watches; the backend records.** The Electron main process
   (`desktop/src/main/folderWatcher.ts`) scans and watches the folders and sends what it sees to new
   endpoints under `/api/folders`. Docker needs no host mounts, and adding a folder needs no
   restart. The backend runs on the same machine, so nothing leaves it.
2. **State lives in Postgres, not SQLite** (migration V12): `folders` and `folder_files` (path,
   content_hash, modified_time, size, status `pending | done | failed | needs_ocr`, error), with
   `user_id` and soft delete like every user-owned table. One store means one place to back up,
   and the same user scoping and tests as the rest of the data.
3. **Quick check, then hash.** A file whose size and modified time match `folder_files` is skipped
   without being read. Only changed or new files are hashed (SHA-256, streamed). Times are compared
   in whole milliseconds, because NTFS keeps 100 ns steps but the stored ISO time keeps milliseconds.
4. **One planner for startup and live changes** (`desktop/src/shared/folderSync.ts`, pure and unit
   tested): given the disk and the index, it plans upload, touch, move, delete or too-large.
   - Same path, same hash: touch (metadata only).
   - Same path, new hash: upload; the backend re-indexes **the same document**
     (`DocumentService.replace`), so the old chunks stay searchable until the new ones land.
   - New path whose hash matches a path that vanished: **move**. The path and display name change,
     nothing is re-indexed. Moves between two watched folders work the same way.
   - Path gone: delete from the index.
5. **Watching:** Node's built-in `fs.watch(folder, { recursive: true })`, which uses Windows'
   native recursive change notifications. Events only mark a folder dirty; after 1.5 s of quiet the
   dirty folders are rescanned together, so a move between folders arrives as one batch. A full
   rescan every 10 minutes covers events the OS dropped.
   We first planned to use chokidar. Version 6.0.0 (the current release, checked on npm) is
   ESM-only and needs Node ≥ 22.22, which doesn't fit the desktop's CommonJS main process, and its
   main benefits (cross-platform recursion, rename pairing) are already covered on Windows by
   `fs.watch` and by hash pairing in the planner. No new dependency.
6. **Never planned as "everything was deleted".** A folder that can't be read (unplugged drive,
   no permission) is skipped. Index entries under an unreadable subfolder, and files modified in the
   last 2 s (possibly still being written) or locked when hashed, are left alone and retried later.
   SMOI only reads the user's files; "delete" always means "remove from SMOI's index".
7. **Shared content and hand uploads.** Documents stay unique per user by content (the partial
   unique index from V3). Two
   files with identical bytes share one document, which is deleted only when the last file pointing
   at it goes. A new `documents.origin` column (`upload | folder`) means folder sync deletes only
   documents it created, so a file the user uploaded by hand survives even if a watched folder held
   the same bytes.
8. **Low priority, crash-safe.** `ingestion_jobs.priority` (0 for hand uploads, 10 for folder
   sync) and the claim query orders by priority, then age. The existing leases (ADR 0005) already
   resume a job after a worker crash. Every desktop action is idempotent, and each start rescans,
   so an interrupted pass finishes on the next one. The desktop sends files one at a time.
9. **needs_ocr instead of failed.** A PDF with fewer than 20 characters of text per page on
   average (`DocumentParser.MIN_CHARS_PER_PAGE`) raises `NeedsOcrException`. The job stops without
   retrying, as for any unreadable file, and the file shows as `needs_ocr`.
10. **Optional OCR sidecar** (`sidecars/ocr`, Compose profile `ocr`, `OCR_ENABLED=false` by
    default): FastAPI, pdfium to render each page at 300 dpi, Tesseract (Debian's `tesseract-ocr`)
    to read it. With it enabled, ingestion sends needs-OCR PDFs to it and indexes the text with page
    numbers; `POST /api/folders/retry-ocr` re-queues files flagged before OCR was turned on. An
    unreachable sidecar is a transient error (retried), not a needs-OCR verdict.
11. **Lock order** is document row, then `folder_files` rows, in both folder sync and the ingestion
    worker's final transaction, so they can't deadlock. Type and duplicate checks happen before any
    write, because an exception thrown inside a nested `@Transactional` call would mark the whole
    transaction for rollback.
12. **Folder endpoints are not rate limited.** The per-user upload bucket (ADR 0011) protects
    interactive uploads. Folder sync is paced by the desktop (one file at a time) and queued at
    low priority; limiting it would only make a first scan of a large folder take hours.

## Alternatives rejected

- **SQLite in the desktop for file state:** a second database to keep consistent with Postgres,
  and it would bypass the user scoping and integration tests the backend already has.
- **Backend watches bind-mounted folders:** every new folder means editing Compose and restarting,
  and Docker Desktop's file events across the Windows/Linux boundary are unreliable.
- **chokidar:** see decision 5.
- **Re-indexing on rename:** wasted embedding work for identical bytes.
- **ocrmypdf:** produces a new PDF with a text layer, which SMOI would then parse again; it pulls in
  Ghostscript and more. Tesseract on rendered pages gives the text directly.
- **Rendering with PyMuPDF:** AGPL-licensed. pypdfium2 (Apache-2.0 / BSD-3) does the same job.

## Consequences

- Folder sync needs the desktop app running; changes made while it is closed are caught at the next
  start.
- Paths are compared case-insensitively with either slash (Windows rules), since the desktop platform is
  Windows 11 (`docs/srs.md`).
- A rename onto a path that the index already has (overwrite) is handled as an upload plus a delete,
  not a move.
- OCR quality depends on the scan. OCR speed and accuracy have not been measured (`TBD`).
- Tests: `backend/src/test/java/com/smoi/folder/FolderSyncIT.java` (each file event, shared content,
  hand uploads, needs-OCR, failures, retries, folder removal),
  `OcrFolderSyncIT.java` (with a fake OCR sidecar, in its own database so the other test contexts'
  workers can't take its jobs), `DocumentParserTest`, `desktop/test/folderSync.test.ts` (planner)
  and `desktop/test/folderWatcher.test.ts` (real folders: live events, restart catch-up, an
  interrupted pass, a backend that is not up yet, pause and resume).
