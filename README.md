# SMOI

SMOI is a Windows desktop companion: a pixel-art frog that sits on your desktop in front of a
retrieval-augmented generation (RAG) backend. You give it your documents (**SMOI Brain**), ask it
questions, and get answers with citations.

> Status: Phase 0 (project setup). The backend has auth and a health check. Retrieval, the frog
> and integrations come in later phases.

## Stack

Java 21 · Spring Boot 4 · PostgreSQL 18 + pgvector · Flyway · Docker Compose · Testcontainers ·
Electron + React + TypeScript (desktop, Phase 6) · Python (evaluation and sidecars).

## Run it

Requires Docker Desktop.

```sh
cp .env.example .env          # then set POSTGRES_PASSWORD and JWT_SECRET (openssl rand -base64 32)
docker compose up --build
```

- Health: `GET http://localhost:8080/actuator/health`
- Register: `POST /api/auth/register` with `{"email": "...", "password": "..."}` (password 12 to 72 characters)
- Login: `POST /api/auth/login` returns `{"accessToken": "...", "tokenType": "Bearer", "expiresAt": "..."}`
- Current user: `GET /api/me` with `Authorization: Bearer <accessToken>`

## Test it

Requires Java 21 and a running Docker (for Testcontainers).

```sh
cd backend
./mvnw verify     # unit tests + integration tests against real Postgres/pgvector
```

CI (`.github/workflows/backend.yml`) runs the same command on every push and pull request.

## Repository

| Path | Contents |
| --- | --- |
| `backend/` | Spring Boot API |
| `desktop/` | Electron frog app (Phase 6) |
| `sidecars/` | Python FastAPI ML helpers, when needed |
| `eval/` | Evaluation scripts (Phase 3) |
| `docs/srs.md` | Requirements |
| `docs/adr/` | Architecture decision records |
| `docs/design/` | Character design: source of truth for SMOI's look and personality |

## Roadmap

0 Setup · 1 Ingestion · 2 Retrieval · 3 Evaluation · 4 Observability and resilience ·
5 Security · 6 Desktop frog · 7 Tasks, reminders and voice · 8 Calendar and Gmail · 9 Packaging
