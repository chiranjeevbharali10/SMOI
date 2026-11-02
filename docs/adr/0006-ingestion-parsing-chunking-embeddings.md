# 0006: Ingestion pipeline: Tika parsing, structure-aware chunking, local embeddings

- Status: Accepted
- Date: 2026-11-02

## Context

SMOI Brain answers questions from the user's documents with citations (Phase 2). Phase 1 has to turn
PDF, DOCX and TXT files into **chunks**: passages small enough to embed and to put in a prompt. Each chunk
needs its source location (page or section, FR-06.03) and an **embedding** (FR-06.04), stored so that
both vector search and keyword search work in Phase 2. The owner must be able to explain every step,
and document text should not leave the machine by default (NFR-04.05).

## Decision

**Parsing: Apache Tika 4.2.0**, with only the PDF, Microsoft and text parser modules.

- Tika reports every format as simple XHTML. `StructureHandler` reads it into headings and paragraphs:
  - PDFs: each page is a `<div class="page">`, which gives a page number for every paragraph.
  - DOCX: headings come through as `<h1>` to `<h6>`.
- The plain-text parser drops blank lines, which are the only paragraph markers in a .txt file. For TXT,
  Tika only detects the character encoding, and `DocumentParser` splits paragraphs itself.
- The upload API decides the file type from the bytes (Tika's detector), not from the filename or the
  client's Content-Type.

**Cleaning** (`TextCleaner`):

- Unicode NFKC normalisation, so ligatures like "ﬁ" become "fi".
- Remove control characters and soft hyphens.
- Rejoin words hyphenated across line breaks.
- Collapse layout line breaks inside a paragraph into spaces.

**Chunking** (`Chunker`), with `max-tokens` 500 and `overlap-tokens` 75 by default, both configurable:

1. A heading starts a new chunk. The chunk records the heading path ("Methods > Sampling") and starts with
   the heading text.
2. Paragraphs stay whole when they fit. A chunk ends before a paragraph that doesn't fit, not inside it.
3. Paragraphs that are too long split at sentence ends. A sentence longer than a chunk splits at words.
4. A new chunk in the same section starts with the last whole sentences of the previous one, up to the
   overlap budget. That way, text near a boundary appears with its context in at least one chunk. Overlap
   never crosses a heading.
5. Tokens are estimated as characters ÷ 4. This keeps chunking independent of the model's tokenizer. The
   error is irrelevant at 500 tokens against a context of 2,048 or more.

Each chunk stores `page_start`/`page_end` (PDF only) and `section`.

**Embeddings**: the `EmbeddingProvider` interface, chosen by `smoi.embedding.provider`.

- `ollama` (default): **`nomic-embed-text`** via a local Ollama, 768 dimensions. It is 274 MB, runs on a
  CPU, has an Apache 2.0 licence and has been in wide use since 2024.
  - It was trained with task prefixes (`search_document: ` / `search_query: `), which are configuration.
  - Chunks are sent in batches of 16.
- `hashing`: a deterministic, model-free embedder (the hashing trick) for tests and CI. It captures word
  overlap only, not meaning.

**Storage** (`V4__document_chunks.sql`):

- `embedding vector(768)` with an HNSW index using cosine distance, for vector search.
- `content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` with a GIN index,
  for keyword search. Both are filled now so Phase 2 can do hybrid search without re-indexing.
- `embedding_model` on every chunk, because vectors from different models can't be compared.

**Re-indexing** replaces chunks atomically. Parsing and embedding run outside any transaction. One short
transaction then deletes the old chunks, inserts the new ones and marks the document indexed. Under
Postgres MVCC, other queries see the old chunks until that commit, so a re-indexed document never
disappears from search.

## Alternatives rejected

- **LangChain4j or Spring AI document readers and splitters.** These would do the same job in a few lines,
  but they hide the chunk boundaries and source tracking that the owner must explain (CLAUDE.md).
- **Fixed-size chunks (every N characters).** Simplest, but cuts sentences and mixes sections. That makes
  citations worse and the chunks less coherent to embed.
- **Semantic chunking (split where embeddings of adjacent sentences diverge).** It might retrieve better,
  but it costs an embedding call per sentence and is harder to explain. Phase 3 can measure it against
  this baseline if retrieval quality needs it.
- **PDFBox, POI and our own text reader directly.** Possible, but that's three APIs instead of one, and
  Tika's type detection is also used for validating uploads.
- **`embeddinggemma-2`** (also 768 dimensions). It may be stronger, but it was released two weeks before
  this decision. Switching to it later is a config change plus a re-index, with no migration.
- **`qwen3-embedding` or `mxbai-embed-large` (1024 dimensions).** Larger and slower on CPU. They would also
  need `vector(1024)`.
- **Hosted embeddings (OpenAI, Voyage, Cohere).** Better quality per call, but document text would leave the
  machine by default, and they cost money and need an API key. They can be added later as another
  provider implementation.
- **An untyped `vector` column, to allow any dimension.** pgvector can't build an HNSW index on a column
  without a fixed dimension.

## Consequences

- **Changing the embedding dimension needs a migration plus a re-index.** A 768-dimension model (such as
  `embeddinggemma-2`) only needs a config change and a re-index. The pipeline refuses vectors of the
  wrong size with a clear error.
- **Scanned PDFs without a text layer fail** with "no extractable text". OCR is out of scope.
- **PDF headings aren't detected**, because Tika doesn't infer them from font sizes. PDF chunks carry
  page numbers, not sections.
- **Chunk size and overlap are guesses until Phase 3 measures them.** No quality claims are made here.
- **Hashing-embedder tests are only a pipeline check.** They prove the wiring and the source locations,
  not retrieval quality.
