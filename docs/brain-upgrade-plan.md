# Brain upgrade plan

Status: Phase 1 (audit and plan). Waiting for owner approval before any code changes.

The request was written for a Python/SQLite app. The owner decided to keep SMOI's stack
(Java 21, Spring Boot 4, Postgres + pgvector; see CLAUDE.md) and to run the folder watcher
in the Electron main process. Each item below is mapped onto that stack.

## Hardware (measured)

`nvidia-smi` on 2026-11-05: NVIDIA GeForce RTX 4050 Laptop GPU, 6141 MiB VRAM total, 295 MiB in use at idle.
RAM is 16 GB per the owner (not measured).

## 1. Audit: current state

| Area | Today | Where |
|---|---|---|
| LLM | `LlmProvider` interface; Ollama (default), Anthropic (opt-in per document via `hostedLlmAllowed`), Stub. Default model `qwen3.5:2b-q4_K_M`, `num_ctx` 8192, streaming, `think: false`. `keep_alive` not set | `backend/src/main/java/com/smoi/llm/`, `application.yml` `smoi.llm.*` |
| Embeddings | `EmbeddingProvider`; `nomic-embed-text` via Ollama, `vector(768)`. Model name stored per chunk (`embedding_model`) | `com/smoi/embedding/`, `V4__document_chunks.sql` |
| Chunking | Heading-aware: headings start chunks, paragraphs kept whole, long ones split by sentence; 500 tokens, 75 overlap; stores page range and heading path | `ingestion/chunking/Chunker.java` |
| Vector store | pgvector HNSW (cosine) | `document_chunks` |
| Keyword search | Postgres `to_tsvector('english')` + GIN, OR'd terms, `ts_rank_cd` | `retrieval/RetrievalRepository.java` |
| Fusion / rerank | RRF k=60; optional reranker sidecar (`ms-marco-MiniLM-L6-v2`), off by default | `retrieval/ReciprocalRankFusion.java`, `sidecars/reranker/app.py` |
| Tools | LLM classifies intent to JSON; `CommandParser` checks against the `Intent` allowlist; the backend only proposes and the desktop confirms | `command/CommandService.java`, `command/Intent.java`, `desktop/src/main/commands.ts` |
| Message flow | `Talk.tsx` → preload IPC `command:interpret` → `main/commands.ts` → `api.ts` → `POST /api/commands/interpret` → (ask_brain) `POST /api/query/stream` → `AnswerService` | as listed |
| Ingestion | Upload API (25 MB), Tika (PDF/DOCX/TXT), SHA-256 dedup, Postgres `JobQueue` with leases, retries and backoff, 2 workers. No OCR (scanned PDFs fail), no folder sync | `document/`, `ingestion/` |
| Filename search, canned replies, route stats | None | — |
| Tests | Backend: Testcontainers pgvector, `*IT`/`*Test`, hashing embedder in tests. Desktop: vitest | `backend/src/test/.../IntegrationTest.java`, `desktop/test/` |
| Evals | `eval/run_eval.py`: recall@k, MRR, nDCG, latency on a synthetic corpus; Makefile targets | `eval/` |

## 2. Mapping the request onto SMOI

| Request | SMOI plan |
|---|---|
| `folders` table and per-file tracking | New Flyway migration: `folders` and `folder_files` (path, content_hash, modified_time, size, status pending/done/failed/needs_ocr, error), with `user_id` and soft delete |
| watchdog and startup rescan | Electron main watcher plus a rescan on launch; the mtime+size check comes first, and files are hashed only if they look changed. Files are sent to the backend; nothing on disk is ever modified |
| Edits, renames, deletes | Edit → re-index (existing `PUT /documents/{id}/file`). Rename or move (same hash) → new path-update endpoint, no re-index. Delete → existing delete of chunks |
| Background queue with crash resume | Reuse `JobQueue` (leases already recover after a crash); add a low-priority lane for folder jobs |
| PyMuPDF / python-docx | Keep Tika; parsing is already per content type, so adding types stays easy |
| needs_ocr and optional OCR | Flag PDFs with little text instead of failing them; optional OCR sidecar, off by default |
| FTS5 and mixed-case names | Keep Postgres FTS; add a `simple`-config tsvector so names like "animAI" aren't stemmed |
| bge-small-en-v1.5 and sqlite-vec | Keep pgvector. Switching to bge-small means 384 dimensions, a migration and re-embedding everything. **Needs owner sign-off** |
| bge-reranker-base | Swap the model in the existing reranker sidecar, loaded lazily on CPU |
| rapidfuzz filename search | `pg_trgm` similarity on file names, plus regex filename extraction in Java (handles spaces) |
| Filler words, min score, "no match" | `QueryNormalizer` before keyword search; minimum score threshold in config |
| Router | New `RouterService` ahead of `CommandService`: command example phrases → document/file search → canned replies (editable data file in SMOI's voice) → LLM. Thresholds and margin in config, route log table, stats endpoint |
| LLM fallback | Existing Ollama provider: `keep-alive` 2m, `num-ctx` 4096, top 3–5 chunks, configurable model (verify the `qwen3.5:4b` / `gemma4:e4b` tags first), in-character offline/out-of-memory errors, pause indexing while the model is loaded (`/api/ps`), structured search filters for vague file requests |

## 3. Files changed per phase (representative)

- **Phase 2 (evals):** file-level test set (query, expected_file, expected_page) in `eval/data/`, reusing `eval/smoi_eval/metrics.py` and `runner.py`; new Makefile target; baseline in `eval/results/`.
- **Phase 3 (folder sync):** `backend/.../folder/` (new), new migration, `desktop/src/main/folderSync.ts` (new), a Folders dashboard screen, optional `sidecars/ocr/`.
- **Phase 4 (search):** `RetrievalRepository`, new `FileNameSearch` and `QueryNormalizer`, min score in `RetrievalService`, embedding migration, `sidecars/reranker/app.py`.
- **Phase 5 (router):** `backend/.../router/` (new), replies data file, `desktop/src/main/commands.ts`.
- **Phase 6 (LLM):** `OllamaLlmProvider`, `LlmConfig`, `application.yml`, `Prompts`, `.env.example`, desktop thinking state.
- **Phase 7:** README, `docs/brain-upgrade-results.md`, removal of dead code.
- ADRs for folder sync, the embedding switch and the router.

## 4. Risks

- Switching embeddings re-indexes every document and makes earlier eval numbers incomparable unless they are rerun.
- `num_ctx` 4096 (down from 8192) may truncate summaries and comparisons.
- A 4b model plus the embedder in 6 GB of VRAM needs measuring.
- Watching folders needs debouncing and must skip files that are still being written.
- The eval corpus is synthetic; 30–50 questions on the owner's real documents need the owner's input (a template will be provided).
- The router's thresholds will misfire on near-miss phrasings until they are tuned against tests.

## Decisions needed before Phase 2

1. Approve this plan.
2. Embedding switch to bge-small-en-v1.5 (384 dimensions, full re-index), or keep `nomic-embed-text`.
3. New dependencies: an Electron watcher library, `pg_trgm` (Postgres contrib), and an optional OCR sidecar.
