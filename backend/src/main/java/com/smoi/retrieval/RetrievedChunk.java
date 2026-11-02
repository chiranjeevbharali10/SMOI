package com.smoi.retrieval;

import java.util.UUID;

/**
 * A chunk found for a query, with where it came from and how it scored.
 *
 * @param score       the score the final ordering used: ts_rank_cd for keyword, cosine
 *                    similarity (1 − distance) for vector, the RRF score for hybrid, the
 *                    cross-encoder score after reranking. Scores of different modes aren't comparable.
 * @param keywordRank 1-based rank in the keyword list, or null if keyword search didn't return it
 * @param vectorRank  1-based rank in the vector list, or null
 */
public record RetrievedChunk(
        UUID chunkId,
        UUID documentId,
        String filename,
        int chunkIndex,
        String content,
        Integer pageStart,
        Integer pageEnd,
        String section,
        double score,
        Integer keywordRank,
        Integer vectorRank) {

    public RetrievedChunk withScore(double newScore) {
        return new RetrievedChunk(chunkId, documentId, filename, chunkIndex, content, pageStart, pageEnd, section,
                newScore, keywordRank, vectorRank);
    }

    RetrievedChunk withRanks(Integer keyword, Integer vector) {
        return new RetrievedChunk(chunkId, documentId, filename, chunkIndex, content, pageStart, pageEnd, section,
                score, keyword, vector);
    }
}
