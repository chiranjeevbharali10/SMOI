package com.smoi.retrieval;

import java.util.List;

/**
 * @param chunks   the final ranking, best first
 * @param rerank   what happened to reranking: {@code not_requested} (another mode),
 *                 {@code applied}, {@code skipped} (the reranker failed; hybrid order used) or
 *                 {@code disabled} (no reranker configured; hybrid order used)
 * @param rerankNote why reranking was skipped, or null
 * @param fallback why retrieval ran in a reduced mode (for example keyword-only because the
 *                 embedding model is down), or null if it ran as requested
 * @param timings  milliseconds per stage
 */
public record RetrievalResult(
        RetrievalMode mode,
        List<RetrievedChunk> chunks,
        String rerank,
        String rerankNote,
        String rerankModel,
        String fallback,
        Timings timings) {

    public record Timings(long embedMs, long keywordMs, long vectorMs, long rerankMs, long totalMs) {
    }
}
