package com.smoi.retrieval;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/** How chunks are found for a query. Selectable per request so Phase 3 can compare them. */
public enum RetrievalMode {

    /** Postgres full-text search: exact words (after stemming). Good for names, codes, rare terms. */
    KEYWORD("keyword"),
    /** Nearest embeddings: same meaning in different words. */
    VECTOR("vector"),
    /** Both, merged with reciprocal rank fusion. */
    HYBRID("hybrid"),
    /** Hybrid, then the top candidates reordered by a cross-encoder reranker. */
    HYBRID_RERANK("hybrid_rerank");

    private final String value;

    RetrievalMode(String value) {
        this.value = value;
    }

    @JsonValue
    public String value() {
        return value;
    }

    @JsonCreator
    public static RetrievalMode fromValue(String value) {
        for (RetrievalMode mode : values()) {
            if (mode.value.equalsIgnoreCase(value)) {
                return mode;
            }
        }
        throw new IllegalArgumentException("Unknown retrieval mode " + value
                + "; use keyword, vector, hybrid or hybrid_rerank");
    }
}
