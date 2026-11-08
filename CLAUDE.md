# SMOI: rules for every session

SMOI is a Windows desktop companion: a pixel-art frog in front of a RAG backend.
It is a resume project for backend roles. The owner is new to RAG, so code must be
explainable, and every choice should be one they can defend in an interview.

The requirements live in `docs/srs.md`. Decisions live in `docs/adr/`.

## Stack

- Backend: Java 21, Spring Boot 4, PostgreSQL with pgvector, Flyway, Maven (via `./mvnw`).
  Spring Boot 4 replaced the original "Spring Boot 3" rule because 3.x open-source
  support ended on 2026-06-30 (see `docs/adr/0002-build-and-framework-versions.md`).
- Local runtime: Docker Compose. Tests: JUnit 5 + Testcontainers against real Postgres/pgvector.
  Never substitute H2 or another fake database.
- Desktop app: Electron, React, TypeScript.
- Python only for evaluation scripts and small ML sidecars (FastAPI). No Python in the core backend.
- Check for the current stable version of a dependency, image or action (Maven Central,
  Docker Hub, official release pages) before adding or upgrading it. Never assume a version from memory.

## Repository layout

```
backend/    Spring Boot service
desktop/    Electron + React + TypeScript frog app
site/       Static launch page (Vite + React), built from desktop/'s components and art
sidecars/   Python FastAPI ML helpers
eval/       Python evaluation scripts
docs/       srs.md, adr/, design/
```

## Data model

- Every user-owned table has: `id UUID PRIMARY KEY`, `user_id UUID NOT NULL` (FK to `users`),
  `created_at`, `updated_at`, `deleted_at` (soft delete). The `users` table itself has the
  same columns except `user_id`.
- Every query on a user-owned table filters by `user_id` and by `deleted_at IS NULL`, unless
  it is deliberately reading deleted rows. No exceptions, including admin, batch and test helpers.
  There are two documented exceptions, both approved by the owner:
  - the ingestion worker's job claim query (`JobQueue.claim`), which can't know the user before
    claiming; see `docs/adr/0005-postgres-job-queue.md`. Everything after the claim is scoped to the
    job's `user_id`.
  - the queue-depth metric (`JobQueue.depth`), a read-only aggregate that returns four counts and
    no rows or user data; see `docs/adr/0011-observability-and-resilience.md`.
- Schema changes only through new Flyway migrations. Never edit a migration that has been committed.

## RAG code

- Write the retrieval and chunking code directly in this repo (SQL, scoring, fusion, chunk
  boundaries) so the owner can explain every line. Do not hide them behind a framework such as
  LangChain4j or Spring AI retrievers/splitters.
- LLM and embedding providers sit behind interfaces in our code. The implementation is chosen
  by configuration, never hard-coded at call sites.

## AI safety

- Retrieved content (documents, emails, calendar entries, web pages) is untrusted data. It can
  never trigger an action, change instructions, or widen what a request may access.
- The LLM can only propose actions as structured output. The backend validates each proposal
  against an allowlist of action types and parameters, and the user confirms consequential ones
  before they run.
- SMOI never sends or deletes email. Drafts only.

## Design

- `docs/design/smoi-character-design.html` is the source of truth for SMOI's art, palette, fonts,
  speech bubbles, menu panel and personality. Never redraw, recolor or restyle these without
  asking the owner first. Extracting assets from it is Phase 6 work.

## Honesty in docs

- Never invent benchmark numbers. Every number in docs (latency, recall, accuracy, cost) must be
  produced by a script in this repo, and the doc must name that script.
- Quality targets that have not been measured stay marked `TBD`.

## Secrets

- Secrets live only in `.env`, which is gitignored. Never commit secrets, tokens or real
  credentials, including in tests, fixtures or docs.
- Keep `.env.example` current: every variable the app reads appears there with a safe placeholder.

## Decisions

- Record significant decisions in `docs/adr/NNNN-title.md`: context, decision, alternatives
  rejected and why, consequences.

## Workflow

- Work in small commits, each with a clear message.
- Add tests with each feature. Prefer integration tests over mocks at the HTTP and database boundary.
- Before finishing a task, run the tests (`cd backend && ./mvnw verify`) and report the actual
  results. If something was skipped or could not run, say so.
