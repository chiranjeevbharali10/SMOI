-- A chunk is a passage of a document, a few hundred tokens long. Retrieval (Phase 2) finds
-- chunks, not whole documents, and each answer cites the chunks it used.
CREATE TABLE document_chunks (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users (id),
    document_id     UUID        NOT NULL REFERENCES documents (id),
    -- Position of the chunk in the document, starting at 0.
    chunk_index     INT         NOT NULL,
    content         TEXT        NOT NULL,
    -- Source location for citations. Pages exist only for PDFs; DOCX and TXT have none.
    page_start      INT,
    page_end        INT,
    -- Heading path the chunk sits under, for example "Methods > Sampling". NULL if the
    -- document has no headings above this chunk.
    section         TEXT,
    token_count     INT         NOT NULL,
    -- Embedding: 768 numbers that place the chunk's meaning in a vector space. The size is
    -- fixed by the embedding model (see docs/adr/0006). Changing to a model with a different
    -- size needs a new migration and a re-index.
    embedding       vector(768) NOT NULL,
    -- Which model produced the embedding. Vectors from different models can't be compared.
    embedding_model TEXT        NOT NULL,
    -- Keyword search (Phase 2). Postgres keeps this in sync with `content` automatically.
    -- 'english' stems words, so "running" also matches "run".
    content_tsv     tsvector    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    CONSTRAINT document_chunks_document_index_uk UNIQUE (document_id, chunk_index)
);

-- Every chunk query filters by user_id first.
CREATE INDEX document_chunks_user_document_idx ON document_chunks (user_id, document_id);

-- HNSW: an approximate nearest-neighbour index, so vector search doesn't compare the query
-- with every chunk. Cosine distance matches how embedding models are trained.
CREATE INDEX document_chunks_embedding_hnsw_idx
    ON document_chunks USING hnsw (embedding vector_cosine_ops);

-- GIN: an inverted index (word -> chunks) for full-text keyword search.
CREATE INDEX document_chunks_content_tsv_idx ON document_chunks USING gin (content_tsv);

CREATE TRIGGER document_chunks_set_updated_at
    BEFORE UPDATE ON document_chunks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
