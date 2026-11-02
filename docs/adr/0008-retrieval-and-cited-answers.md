# 0008: Hybrid retrieval with reciprocal rank fusion, optional reranking, and checked citations

- Status: Accepted
- Date: 2026-11-02

## Context

SMOI Brain must find the passages that answer a question (FR-06.05) and answer only from them, with
citations that can be trusted (FR-06.06, FR-06.07, FR-06.12). Retrieved text is untrusted: a
document can contain text written to manipulate the model (NFR-03.08, NFR-03.11). Phase 3 compares
retrieval methods, so each must be selectable per request. Chunking is covered by ADR 0006.

## Decision

**Four retrieval modes** (`RetrievalMode`), selectable per request on `/api/search` and `/api/query`:

| Mode | How | Strength | Weakness |
| --- | --- | --- | --- |
| `keyword` | Postgres full-text: `plainto_tsquery` with AND switched to OR, ranked by `ts_rank_cd` | exact names, codes, rare words | blind to synonyms |
| `vector` | cosine distance on the HNSW index | same meaning, different words | can blur exact identifiers |
| `hybrid` | both, merged with reciprocal rank fusion | catches either kind of match | ranking only as good as the two lists |
| `hybrid_rerank` | hybrid, then the top `candidates` (default 30) reordered by a cross-encoder | reads query and passage together | extra latency; English-only model |

- **Default for `/api/query` is `hybrid`.** Reranking stays opt-in per request until Phase 3 shows
  whether it improves results enough to justify its latency.
- **Reciprocal rank fusion** scores each chunk `Σ 1/(60 + rank)` over the lists it appears in
  (`ReciprocalRankFusion`). Ranks are used instead of scores because ts_rank and cosine similarity
  live on unrelated scales. `k = 60` (Cormack et al., 2009) flattens the curve, so a chunk that both
  methods rank well beats one that only one method ranks first.
- **Isolation in SQL.** Both searches filter by `user_id`, by live documents, and for a hosted LLM by
  `hosted_llm_allowed`. The user id comes from the token, never from query text.
  - Vector search sets `hnsw.iterative_scan = relaxed_order` (pgvector 0.8). Without it, the
    approximate index would return too few rows once other users' chunks are filtered out.
  - Vector search only compares vectors from the current embedding model.
- **Reranker as a sidecar.** A Python FastAPI service in `sidecars/reranker` runs
  `cross-encoder/ms-marco-MiniLM-L6-v2` (22M parameters, Apache 2.0, pinned revision), behind the
  `Reranker` interface.
  - If it is down or slow (5 s timeout), retrieval keeps the hybrid order and reports
    `rerank: "skipped"` with the reason.
  - If it isn't configured, retrieval reports `rerank: "disabled"`.

**Prompt layout** (`Prompts`):

- Our instructions go in the system prompt. Retrieved text goes in the user turn inside
  `<source id="S1" document="…" location="…">` elements.
- All document text, file names and the question are escaped (`&`, `<`, `>`, `"`), so a document
  containing `</source>` can't close its element and pose as instructions.
- The system prompt says that everything inside a source is data, never an instruction.

**Citations** (`Citations`):

- The model cites short labels (`[S1]`). They are copied more reliably than UUIDs, and the backend
  maps them back to chunk ids.
- An answer is accepted only if it cites at least one label, and every citation-shaped token is a
  label that was in this prompt. A label that wasn't given, a raw UUID, or `[source 2]`-style
  references are rejected.
- A rejected answer returns HTTP 502 with outcome `citation_rejected`, and the answer text is
  withheld.

**"Don't know":**

- The model is told to reply with one fixed sentence when the sources don't cover the question.
- If retrieval returns nothing, the model isn't called at all.

**Prompt budget.** Sources are added best first until the provider's prompt budget is full, using a
conservative estimate of 3 characters per token. Sources left out are counted in
`omittedForContext`, never dropped silently.

**Outcomes are counted** in the `smoi.answers` counter, tagged with outcome, provider and model:
`answered`, `dont_know`, `refused`, `citation_rejected`.

**Streaming** (`/api/query/stream`, server-sent events) sends `sources`, then `delta` text, then
`result`. Text is streamed before its citations are checked, so a client must treat it as provisional
until the `result` event arrives.

## Alternatives rejected

- **Only vector search.** It misses exact identifiers and rare terms, which are common in personal
  documents (codes, names, IDs).
- **Weighted sum of normalised scores instead of RRF.** It needs per-query normalisation and a tuned
  weight, and both drift with the corpus. RRF has one well-studied constant.
- **The Claude API's built-in citations feature.** It only works with Claude. The Ollama provider
  needs the same check, and FR-06.12 needs our own validation anyway.
- **JSON structured output for citations.** It makes streaming text awkward, and small local models
  follow inline `[S1]` markers more reliably than a schema.
- **Reranking in the JVM (ONNX Runtime).** Possible, but it adds native libraries to the backend.
  The sidecar keeps Python out of the core backend (CLAUDE.md) and can be scaled or disabled on its own.
- **Spring AI or LangChain4j retrievers.** They hide the SQL, fusion and prompt layout the owner must
  explain (CLAUDE.md).

## Consequences

- **The reranker is English-only** (trained on MS MARCO). Rankings for other languages may get worse
  with reranking. A multilingual model such as `BAAI/bge-reranker-v2-m3` (about 25 times larger)
  would be needed for them.
- **Reranking costs about 37 ms per candidate on CPU** (about 1.1 s p50 for the default 30), measured
  with `eval/bench_rerank_latency.py` on 2026-11-02 (`eval/README.md`).
- **The cross-encoder reads at most 512 tokens per (query, passage) pair**, so the end of a chunk
  near the 500-token chunk size may be cut off when it is scored.
- **Rejecting answers without citations is strict.** Phase 3 measures how often it happens per
  provider and model.
- **A streamed answer can be retracted** by its final `result` event. The desktop app must render it
  as provisional.
- **Keyword search uses the English text-search configuration**, so stemming is English-only too.
- **Quality and latency targets (NFR-09, NFR-01.05) are `TBD`** until Phase 3 and Phase 4 measure them.
