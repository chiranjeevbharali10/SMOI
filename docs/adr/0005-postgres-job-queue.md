# 0005: Postgres job queue with FOR UPDATE SKIP LOCKED for ingestion

- Status: Accepted
- Date: 2026-11-02

## Context

Indexing a document (parse, chunk, embed, store) can take seconds to minutes, mostly waiting for the
embedding model. Uploads must return immediately (FR-06.01), so the work runs in the background. It has to:

- survive a crash or `taskkill` of the backend without losing work (NFR-02.04),
- retry temporary failures with backoff, then stop in a dead-letter state with the reason (NFR-02.06),
- let several workers run at once without two of them processing the same job (NFR-06.02),
- never index a document twice or leave it half-indexed when a request is retried (NFR-02.03).

SMOI is a single-user desktop backend that already runs Postgres.

## Decision

Jobs are rows in an `ingestion_jobs` table (`V5__ingestion_jobs.sql`). The upload transaction inserts
the document and its job together, so neither can exist without the other.

- **Claiming.** A worker runs one `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING ...` (`JobQueue.claim`). `SKIP LOCKED` makes concurrent workers skip a row another worker has
  just locked instead of waiting for it or taking it too. The same statement sets `status = 'running'`,
  increments `attempts` and writes a new random `lease_token`.
- **Leases instead of "in progress forever".** `available_at` is the earliest time anyone may claim the job.
  For a running job it is the lease expiry. The worker renews the lease between pipeline steps. If the
  process dies, renewals stop, and once the lease expires the claim query picks the job up again. If the
  final attempt dies this way, the next claim moves the job to `dead` instead of trying again.
- **Fencing with the lease token.** Every update to a claimed job includes `lease_token = ? AND
  status = 'running'`. A worker that hung, lost its lease and later wakes up finds its update matches no
  row, so it stops without writing anything. Its results can't overwrite those of the worker that took over.
- **Retries.** A temporary failure, such as the embedding provider being unreachable, sets the job back to
  `queued` with `available_at = now() + base × 2^(attempt−1)`, capped (`IngestionProperties.backoffAfter`).
  After `max_attempts` the job becomes `dead` and keeps `last_error`. A permanent failure, such as a corrupt
  or text-less file, goes to `dead` at once, because retrying can't change the outcome.
- **Versions.** Each job is for one `document_version`. Replacing or deleting a document cancels its
  unfinished jobs, and the worker's final transaction only commits if that version is still current.
- **Lock order.** Every transaction that touches both a document and its job locks the document row first.
  Upload, replace, delete and the worker's final write follow this order, so they can't deadlock each other.

### The one cross-user query

CLAUDE.md requires every query on a user-owned table to filter by `user_id`. The claim query can't: a
worker doesn't know whose job is next until it has claimed it. This is the only exception:

- `JobQueue.claim` is the only query without a `user_id` filter. It returns only ids (job, user, document,
  version) and reads no document content.
- Everything the worker does afterwards (loading the file, writing chunks, updating status) filters by the
  claimed job's `user_id`.
- No API endpoint calls it.

## Alternatives rejected

- **RabbitMQ.** It's a mature broker with acknowledgements, redelivery and dead-letter exchanges. But it is
  a second stateful service to run, monitor and back up next to Postgres. Enqueuing would also no longer be
  atomic with the document insert: a crash between "commit document" and "publish message" would lose the
  job, unless we added an outbox table. That outbox table would be the Postgres queue again.
- **Kafka.** Built for high-throughput event streams with replay, not for a work queue of individually
  retried jobs. It needs more operation than a desktop app can justify, and per-job retry with backoff
  isn't built in.
- **Spring `@Async` or an in-memory executor.** Simple, but a crash loses every queued job. That fails
  NFR-02.04 outright.
- **A job library (JobRunr, db-scheduler, Quartz).** They work and use the same Postgres locking ideas
  underneath. But they hide the mechanism this project is meant to demonstrate and explain, for about
  150 lines of our own code.
- **Polling with `SELECT ... FOR UPDATE` without `SKIP LOCKED`.** Workers would queue up behind the
  first locked row, so adding workers would add waiting, not throughput.

## Consequences

- Postgres stays the only infrastructure. Enqueuing is transactional with the document write.
- Workers poll (default every 1 s when idle). That adds up to a second of delay to the first step of a new
  job and runs one cheap indexed query per worker per second. `LISTEN/NOTIFY` could remove the delay if it
  ever matters.
- The throughput ceiling is far above what one user's uploads need. A multi-tenant service with thousands
  of jobs per second would have to measure this before relying on it.
- A job can run more than once if a worker is slow rather than dead (its lease expires while it is still
  working). Fencing makes sure only one run commits. The worker renews its lease before each embedding
  batch so this is rare.
- A parser that hangs inside Tika keeps its thread busy until restart. The job itself is recovered after
  its lease expires, but that thread is lost. Running Tika in a separate process with a timeout is a
  Phase 5 hardening option.
