# 0011: Observability and resilience: Prometheus, OpenTelemetry, circuit breakers, Postgres-backed limits and cache

- Status: Accepted
- Date: 2026-11-03

## Context

Phase 4 (NFR-01, NFR-02, NFR-06, NFR-07) needs four things:

- show how SMOI behaves under load and where time goes;
- keep answering usefully when a model provider is down;
- protect the backend from one user flooding it;
- prove all of this with measurements.

SMOI runs locally on one machine, but the design must still hold with two backend instances
sharing one database (NFR-06.01). The measured results are in `docs/performance.md`.

## Decision

**Metrics: Micrometer to Prometheus, dashboards in Grafana.**

- The backend serves `/actuator/prometheus` on a separate management port (8081). Compose doesn't
  publish that port; only Prometheus, inside the Compose network, scrapes it.
- `/livez` and `/readyz` stay on the API port for the desktop app and health checks.
- SMOI's own meters:
  - `smoi_retrieval_stage_seconds{stage,mode}`
  - `smoi_llm_generation_seconds`, `smoi_llm_first_token_seconds`, `smoi_llm_tokens_total`
  - `smoi_llm_cost_usd`: an estimate from configured list prices; a local model costs 0
  - `smoi_ingestion_job_seconds{outcome}`, `smoi_ingestion_stage_seconds{stage}`
  - `smoi_ingestion_queue_jobs{state}`, `smoi_ingestion_queue_oldest_ready_seconds`
  - `smoi_answers_total{outcome}`
  - `smoi_rate_limit_rejected_total`, `smoi_retrieval_fallback_total`
  - `smoi_query_embedding_cache_total{result}`
  - Resilience4j breaker state
- Latency meters publish histograms, so p95 can be computed across instances.
- Two dashboards are provisioned from JSON in `observability/grafana/dashboards/`.

**Queue depth reads the database.** The gauges run one aggregate query, `JobQueue.depth`, cached for
5 s.

- It counts jobs across all users, so it is the second approved exception to the `user_id` rule.
- It returns four numbers and no rows or user data.
- Counting in memory was rejected because the number would be wrong after a restart and with
  several instances.

**Traces: OpenTelemetry (Spring Boot's starter) to Jaeger over OTLP.**

- HTTP and security spans come for free.
- `Spans` adds child spans for `retrieval.embed/keyword/vector/rerank`, `llm.generate` and
  `ingestion.job/parse/chunk/embed`.
- Spans use `Tracer` directly rather than Micrometer Observations, which would also create timers
  that clash with the explicit ones.
- Spans carry stage names and modes only, never document text, questions or answers.

**Logs: JSON (Spring Boot's logstash format) with a request id.**

- `RequestIdFilter` runs first. It takes a caller's `X-Request-Id` only if it is at most 64 plain
  characters (anything else could inject into logs), otherwise generates a UUID, returns it, and puts
  it in the MDC.
- The id is stored on the ingestion job (V7), so a job's log lines carry the id of the upload that
  created it.
- Streaming answers carry it across to their worker thread.
- `ObservabilityIT` checks with a sentinel that document text, the question, passwords and tokens
  never appear in log output.

**Circuit breakers: Resilience4j's core module, used directly (`ProviderCircuitBreakers`).**

- One breaker each for the LLM, the embedding provider and the reranker.
- Each is count-based: it opens at 50% failures over the last 10 calls, after at least 4 calls. It
  stays open 30 s, then lets 2 trial calls through.
- Only provider outages count as failures (`LlmUnavailableException`, `EmbeddingException`,
  `RerankerUnavailableException`). A refusal or an over-long prompt is the request's problem.
- Calls are wrapped at the service layer, so the call sites show where protection applies and test
  doubles still work.
- The Spring Boot starter was rejected: its Boot 4 module is new, and annotations hide what is
  wrapped.

**Fallbacks (NFR-02.07):**

- **LLM down or breaker open:** `/api/query` returns HTTP 200 with outcome `llm_unavailable`, a notice
  that the passages haven't been summarised or checked, and the retrieved passages. Summaries and
  comparisons have no useful fallback and return 503.
- **Embedding model down:** vector and hybrid retrieval fall back to keyword search and say so in a
  `fallback` field. Ingestion jobs fail fast through the breaker and retry with backoff.
- **Reranker down:** results keep the hybrid order (unchanged from ADR 0008).

**Timeouts.**

- Provider clients connect within 5 s (`ProviderTimeouts.CONNECT`); read timeouts stay per provider
  (LLM 180 s, embeddings 60 s, reranker 5 s).
- Database: 5 s to get a pooled connection, 30 s per statement.
- The Anthropic SDK keeps its own retry policy. The breaker sees only the final outcome.

**Rate limiting: per-user token buckets in Postgres (`RateLimiter`, V8).**

- One `INSERT ... ON CONFLICT DO UPDATE` refills the bucket from the elapsed time and takes a token.
  The row lock makes concurrent requests on any instance take tokens one at a time, and Postgres's
  clock is the only clock.
- Separate buckets for query, search and upload, configurable. Over the limit returns 429 with
  `Retry-After`.
- Bucket4j was rejected: its table doesn't follow this project's schema rules (id, user_id,
  timestamps, soft delete), and the SQL here is short enough to explain line by line. An in-memory
  limiter was rejected because each instance would allow the full rate.

**Query embedding cache, added because measurements showed it helps (`QueryEmbeddingCache`, V9).**

- Load tests showed embedding the question is almost all of retrieval time on this CPU-only machine.
- The cache is exact-match (after trimming, lower-casing and collapsing spaces), per user, with a
  1-day TTL.
- It stores only the SHA-256 of the question.
- It lives in Postgres, so instances share it and it follows the user-data rules.
- It is per user so a fast hit can't reveal that another user asked the same question.
- It only helps repeated questions; for new questions it adds a small cost (see
  `docs/performance.md`).

**Load-test stub.** `LLM_PROVIDER=stub` answers after a fixed delay (default 200 ms) with a cited
sentence. Throughput tests use it so they measure SMOI rather than a CPU-bound model. It reports
itself as provider `stub` everywhere.

**Separate API and worker processes (NFR-06.04).** The same image runs both roles, chosen by
configuration only: `INGESTION_WORKERS=0` for the API, workers enabled for the worker. The Compose
`split` profile runs `backend-api` and `backend-worker`.

## Alternatives rejected

- **OTLP push for metrics:** pull by Prometheus is simpler locally and needs no collector.
- **Tempo instead of Jaeger:** Tempo needs Grafana to view traces and more configuration; Jaeger
  is one container with its own UI.
- **An in-memory cache or rate limiter:** wrong with more than one instance.
- **Breaker state shared across instances:** each instance learns about an outage from its own
  calls within seconds; sharing would need extra infrastructure for little gain.
- **`OLLAMA_NUM_PARALLEL=4`:** measured, and it didn't raise embedding throughput on a CPU-only
  machine, so Ollama's default is kept.

## Consequences

- The default stack now includes Prometheus, Grafana and Jaeger, about 0.5 GB of RAM in total
  (measured in `docs/performance.md`).
- Every expensive request now makes one rate-limit write. Under heavy cached load Postgres becomes
  the next bottleneck.
- A cache hit costs a database round trip; a miss costs that plus an insert, which is the measured
  slowdown on unique questions.
- Grafana allows anonymous read-only viewing, bound to 127.0.0.1. Phase 5 revisits exposure.
