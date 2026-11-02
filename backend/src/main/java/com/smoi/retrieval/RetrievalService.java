package com.smoi.retrieval;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import com.smoi.embedding.EmbeddingProvider;
import com.smoi.retrieval.rerank.RerankProperties;
import com.smoi.retrieval.rerank.Reranker;
import com.smoi.retrieval.rerank.RerankerUnavailableException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Finds the chunks most relevant to a query, in the requested mode. Every search is scoped to
 * the authenticated user: the user id comes from the token, never from the query text.
 */
@Service
public class RetrievalService {

    private static final Logger log = LoggerFactory.getLogger(RetrievalService.class);

    /** Each first-stage list is longer than the final top-k, so fusion has candidates to work with. */
    private static final int FIRST_STAGE_MULTIPLIER = 4;
    private static final int FIRST_STAGE_MIN = 20;

    private final RetrievalRepository repository;
    private final EmbeddingProvider embeddings;
    private final Optional<Reranker> reranker;
    private final RerankProperties rerankProps;

    public RetrievalService(RetrievalRepository repository, EmbeddingProvider embeddings, Optional<Reranker> reranker,
                            RerankProperties rerankProps) {
        this.repository = repository;
        this.embeddings = embeddings;
        this.reranker = reranker;
        this.rerankProps = rerankProps;
    }

    /**
     * @param hostedOnly restrict to documents the user allowed to be sent to a hosted LLM
     */
    public RetrievalResult retrieve(UUID userId, String query, RetrievalMode mode, int topK, boolean hostedOnly) {
        long start = System.nanoTime();
        int firstStage = Math.max(FIRST_STAGE_MIN, topK * FIRST_STAGE_MULTIPLIER);
        if (mode == RetrievalMode.HYBRID_RERANK) {
            firstStage = Math.max(firstStage, rerankProps.candidates());
        }
        long embedMs = 0;
        long keywordMs = 0;
        long vectorMs = 0;

        List<RetrievedChunk> keyword = List.of();
        List<RetrievedChunk> vector = List.of();
        if (mode != RetrievalMode.VECTOR) {
            long t = System.nanoTime();
            keyword = repository.keyword(userId, query, firstStage, hostedOnly);
            keywordMs = millisSince(t);
        }
        if (mode != RetrievalMode.KEYWORD) {
            long t = System.nanoTime();
            float[] queryVector = embeddings.embedQuery(query);
            embedMs = millisSince(t);
            t = System.nanoTime();
            vector = repository.vector(userId, queryVector, embeddings.modelId(), firstStage, hostedOnly);
            vectorMs = millisSince(t);
        }

        List<RetrievedChunk> ranked = switch (mode) {
            case KEYWORD -> withRanks(keyword, true);
            case VECTOR -> withRanks(vector, false);
            case HYBRID, HYBRID_RERANK -> ReciprocalRankFusion.fuse(keyword, vector, ReciprocalRankFusion.DEFAULT_K);
        };

        String rerankStatus = "not_requested";
        String rerankNote = null;
        String rerankModel = null;
        long rerankMs = 0;
        if (mode == RetrievalMode.HYBRID_RERANK) {
            if (reranker.isEmpty()) {
                rerankStatus = "disabled";
                rerankNote = "No reranker is configured (smoi.rerank.enabled=false); results are in hybrid order";
            } else if (!ranked.isEmpty()) {
                long t = System.nanoTime();
                try {
                    ranked = rerank(query, ranked, reranker.get());
                    rerankStatus = "applied";
                    rerankModel = reranker.get().modelId();
                } catch (RerankerUnavailableException e) {
                    // Retrieval still works without the reranker: keep the hybrid order.
                    log.warn("Reranking skipped: {}", e.getMessage());
                    rerankStatus = "skipped";
                    rerankNote = e.getMessage();
                }
                rerankMs = millisSince(t);
            } else {
                rerankStatus = "applied";
                rerankModel = reranker.get().modelId();
            }
        }

        List<RetrievedChunk> top = ranked.size() > topK ? ranked.subList(0, topK) : ranked;
        return new RetrievalResult(mode, List.copyOf(top), rerankStatus, rerankNote, rerankModel,
                new RetrievalResult.Timings(embedMs, keywordMs, vectorMs, rerankMs, millisSince(start)));
    }

    /** Reorders the top candidates by cross-encoder score; anything below the candidate cut keeps its hybrid order after them. */
    private List<RetrievedChunk> rerank(String query, List<RetrievedChunk> hybrid, Reranker reranker) {
        int n = Math.min(rerankProps.candidates(), hybrid.size());
        List<RetrievedChunk> candidates = hybrid.subList(0, n);
        List<Double> scores = reranker.score(query, candidates.stream().map(RetrievedChunk::content).toList());
        List<RetrievedChunk> reranked = new ArrayList<>(hybrid.size());
        for (int i = 0; i < n; i++) {
            reranked.add(candidates.get(i).withScore(scores.get(i)));
        }
        reranked.sort(Comparator.comparingDouble(RetrievedChunk::score).reversed());
        reranked.addAll(hybrid.subList(n, hybrid.size()));
        return reranked;
    }

    private static List<RetrievedChunk> withRanks(List<RetrievedChunk> list, boolean keyword) {
        List<RetrievedChunk> out = new ArrayList<>(list.size());
        for (int i = 0; i < list.size(); i++) {
            RetrievedChunk c = list.get(i);
            out.add(keyword ? c.withRanks(i + 1, null) : c.withRanks(null, i + 1));
        }
        return out;
    }

    private static long millisSince(long nanoStart) {
        return (System.nanoTime() - nanoStart) / 1_000_000;
    }
}
