# 0004: Integration tests run against real Postgres via Testcontainers

- Status: Accepted
- Date: 2026-11-02

## Context

SMOI depends on Postgres-specific features: the pgvector extension, partial unique indexes,
triggers and, from Phase 2, full-text search. Tests must exercise those features, not an imitation of them.

## Decision

Integration tests (`*IT.java`, run by Maven Failsafe in `./mvnw verify`) start the app on a
random port and point it at a `pgvector/pgvector:0.8.7-pg18-trixie` container started by
Testcontainers. One container is shared by all test classes in a run. Flyway migrates it exactly as in
production. Fast unit tests (`*Test.java`) need no Docker.

## Alternatives rejected

- **H2 in PostgreSQL mode.** It has no pgvector, a different SQL dialect and different index behavior, so tests could
  pass while production fails.
- **A shared local or dev database.** Results depend on leftover state, and CI can't reproduce it.
- **Mocking the repository layer.** This tests the mocks rather than the SQL, and the SQL is where the
  risky logic (user_id filtering, retrieval) lives.

## Consequences

- Docker must be running to run `./mvnw verify` locally. GitHub's Ubuntu runners already have it.
- The first run downloads the image. Later runs reuse it.
