# SMOI

SMOI is a Windows desktop companion: a pixel-art frog that sits on your desktop in front of a
retrieval-augmented generation (RAG) backend. You give it your documents (**SMOI Brain**), ask it
questions, and get answers with citations.

> Status: Phase 2 (retrieval and cited answers). Upload PDF, DOCX and TXT files, then ask questions
> and get answers that cite the exact passages they came from. The frog and integrations come later.

## Stack

Java 21 · Spring Boot 4 · PostgreSQL 18 + pgvector · Flyway · Docker Compose · Testcontainers ·
Electron + React + TypeScript (desktop, Phase 6) · Python (evaluation and sidecars).

## Run it

Requires Docker Desktop.

```sh
cp .env.example .env          # then set POSTGRES_PASSWORD and JWT_SECRET (openssl rand -base64 32)
docker compose up --build
```

- Health: `GET http://localhost:8080/livez` (and `/readyz`)
- Dashboards: Grafana at http://localhost:3000 (SMOI folder), traces in Jaeger at http://localhost:16686,
  raw metrics in Prometheus at http://localhost:9090
- Register: `POST /api/auth/register` with `{"email": "...", "password": "..."}` (password 12 to 72 characters)
- Login: `POST /api/auth/login` returns `{"accessToken": "...", "tokenType": "Bearer", "expiresAt": "..."}`
- Current user: `GET /api/me` with `Authorization: Bearer <accessToken>`

The first `docker compose up` also downloads the embedding model (`nomic-embed-text`, about 274 MB)
into a volume. The backend starts once that finishes.

### SMOI Brain documents

All with `Authorization: Bearer <accessToken>`.

| Request | What it does |
| --- | --- |
| `POST /api/documents` (multipart field `file`) | Upload a PDF, DOCX or TXT (up to 25 MB). Returns `202` with `{"id", "status": "queued"}` at once, or `200` with the existing document if you already uploaded the same file. |
| `GET /api/documents` | Your documents, newest first, with status `queued`, `processing`, `indexed` or `failed` (plus `error`). |
| `GET /api/documents/{id}` | One document's status. |
| `GET /api/documents/{id}/chunks` | The chunks it was split into, with `pageStart`/`pageEnd` (PDF) and `section` (heading path). |
| `PUT /api/documents/{id}/file` | Replace the file and re-index. The old chunks stay searchable until the new ones are stored. |
| `DELETE /api/documents/{id}` | Delete the document, its file, chunks and vectors. |

```sh
curl -H "Authorization: Bearer $TOKEN" -F file=@notes.pdf http://localhost:8080/api/documents
```

### Asking questions

| Request | What it does |
| --- | --- |
| `POST /api/query` `{"question": "...", "mode": "hybrid", "topK": 6}` | An answer with citations (document, page or section, chunk). `outcome` is `answered`, `dont_know`, `refused` (the hosted provider declined), or `citation_rejected` (HTTP 502: the model cited something it wasn't given, so the answer is withheld). Includes provider, model and per-stage timings. |
| `POST /api/query/stream` | The same as server-sent events: `sources`, `delta` (text), `result`. Treat streamed text as provisional until `result`. |
| `POST /api/search` `{"query": "...", "mode": "keyword"}` | Retrieval only: ranked chunks with scores. Modes: `keyword`, `vector`, `hybrid`, `hybrid_rerank`. |
| `POST /api/documents/{id}/summary`, `POST /api/documents/compare` `{"first", "second"}` | Summary or comparison with citations. |
| `PATCH /api/documents/{id}` `{"hostedLlmAllowed": true}` | Allow this document to be sent to a hosted LLM. Off by default. |
| `GET /api/settings/providers` | Active LLM, embedding and reranker providers, and whether each is hosted. |
| `GET /v3/api-docs` | OpenAPI spec generated from the code. |

The default LLM is a local model through Ollama (`qwen3.5:2b-q4_K_M`). To use Claude instead, set
`LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `.env`; only documents you allowed are sent.
The optional reranker runs with `docker compose --profile rerank up` and `RERANK_ENABLED=true`.
Retrieval and answers: [ADR 0008](docs/adr/0008-retrieval-and-cited-answers.md); providers:
[ADR 0009](docs/adr/0009-llm-providers.md).

### How ingestion works

Upload stores the file and a job row in one transaction. Background workers claim jobs from Postgres
with `FOR UPDATE SKIP LOCKED`, then parse the file (Apache Tika), clean the text, split it into chunks
that respect headings and paragraphs, embed each chunk (local Ollama), and store chunks, vectors and a
full-text index in one short transaction.

Failed jobs retry with exponential backoff and end in a dead-letter state with the reason. A job whose
worker crashes is picked up again when its lease expires. Details and trade-offs:
[ADR 0005](docs/adr/0005-postgres-job-queue.md) (queue),
[ADR 0006](docs/adr/0006-ingestion-parsing-chunking-embeddings.md) (parsing, chunking, embeddings),
[ADR 0007](docs/adr/0007-store-uploaded-files-in-postgres.md) (file storage).

## Test it

Requires Java 21 and a running Docker (for Testcontainers).

```sh
cd backend
./mvnw verify     # unit tests + integration tests against real Postgres/pgvector
```

Tests use a deterministic hashing embedder instead of Ollama, so no model download is needed.
[docs/traceability.md](docs/traceability.md) maps requirements to the tests that check them.

CI (`.github/workflows/backend.yml`) runs the same command on every push and pull request.

### Observability and resilience

- **Metrics** per pipeline stage, queue depth, job outcomes, LLM tokens and estimated cost, circuit
  breaker state and rate-limit rejections go to Prometheus. Grafana shows two provisioned dashboards.
- **Traces** of every upload and query (retrieval stages, LLM call, ingestion stages) go to Jaeger.
- **Logs** are JSON with a request id (`X-Request-Id`) that follows an upload into its ingestion
  job. They never contain document text, questions, passwords or tokens.
- **When the LLM is down**, `/api/query` returns the retrieved passages with a notice (outcome
  `llm_unavailable`). When the embedding model is down, search falls back to keyword-only and says
  so. Circuit breakers stop calling a failing provider for 30 s.
- **Per-user rate limits** (429 with `Retry-After`) and a per-user query-embedding cache are stored
  in Postgres, so several backend instances share them.
- **Load and failure tests:** `python loadtest/run.py query|search|upload|worker-kill|llm-down|scale`.
  Measured results are in `docs/performance.md`.

## Repository

| Path | Contents |
| --- | --- |
| `backend/` | Spring Boot API |
| `desktop/` | Electron frog app (Phase 6) |
| `sidecars/` | Python FastAPI ML helpers, when needed |
| `eval/` | Evaluation harness, demo corpus and question set (Phase 3) |
| `loadtest/` | k6 load tests and failure tests (Phase 4) |
| `observability/` | Prometheus config and Grafana dashboards |
| `docs/srs.md` | Requirements |
| `docs/adr/` | Architecture decision records |
| `docs/design/` | Character design: source of truth for SMOI's look and personality |

## Roadmap

0 Setup · 1 Ingestion · 2 Retrieval · 3 Evaluation · 4 Observability and resilience ·
5 Security · 6 Desktop frog · 7 Tasks, reminders and voice · 8 Calendar and Gmail · 9 Packaging
