package com.smoi.retrieval.rerank;

import java.util.List;

/**
 * Scores how well each passage answers a query. A cross-encoder reads the query and one passage
 * together, so it can judge relevance more precisely than comparing two separately computed
 * embeddings. It is too slow to run on every chunk, so it only reorders the top candidates.
 */
public interface Reranker {

    /** Model name, reported in responses. */
    String modelId();

    /**
     * One score per passage, in input order. Higher means more relevant.
     *
     * @throws RerankerUnavailableException if the reranker can't be reached or answers badly;
     *                                      retrieval then falls back to the hybrid order
     */
    List<Double> score(String query, List<String> passages);
}
