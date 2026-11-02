package com.smoi.retrieval;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Merges the keyword and vector result lists into one ranking with reciprocal rank fusion (RRF).
 *
 * <p>Each chunk scores {@code 1 / (k + rank)} for every list it appears in, and the scores are
 * added up. Why ranks and not the original scores: a ts_rank of 0.3 and a cosine similarity of
 * 0.3 mean unrelated things, and their ranges differ per query, so adding them would let one
 * method drown out the other. Ranks are always comparable.
 *
 * <p>Why {@code k = 60} (the value from the original RRF paper, Cormack et al. 2009): it flattens
 * the curve so that being first isn't worth much more than being fifth. A chunk that both
 * methods rank fairly well (for example 3rd and 4th) beats one that only one method ranks first.
 * That rewards agreement between two different kinds of evidence.
 */
public final class ReciprocalRankFusion {

    public static final int DEFAULT_K = 60;

    private ReciprocalRankFusion() {
    }

    public static List<RetrievedChunk> fuse(List<RetrievedChunk> keyword, List<RetrievedChunk> vector, int k) {
        Map<UUID, Double> scores = new LinkedHashMap<>();
        Map<UUID, RetrievedChunk> chunks = new LinkedHashMap<>();
        Map<UUID, Integer> keywordRanks = new LinkedHashMap<>();
        Map<UUID, Integer> vectorRanks = new LinkedHashMap<>();
        addList(keyword, k, scores, chunks, keywordRanks);
        addList(vector, k, scores, chunks, vectorRanks);

        List<RetrievedChunk> fused = new ArrayList<>(chunks.size());
        for (Map.Entry<UUID, RetrievedChunk> e : chunks.entrySet()) {
            UUID id = e.getKey();
            fused.add(e.getValue().withScore(scores.get(id)).withRanks(keywordRanks.get(id), vectorRanks.get(id)));
        }
        // Ties (same fused score) are broken by chunk id so results are deterministic.
        fused.sort(Comparator.comparingDouble(RetrievedChunk::score).reversed()
                .thenComparing(RetrievedChunk::chunkId));
        return fused;
    }

    private static void addList(List<RetrievedChunk> list, int k, Map<UUID, Double> scores,
                                Map<UUID, RetrievedChunk> chunks, Map<UUID, Integer> ranks) {
        for (int i = 0; i < list.size(); i++) {
            RetrievedChunk chunk = list.get(i);
            int rank = i + 1;
            scores.merge(chunk.chunkId(), 1.0 / (k + rank), Double::sum);
            chunks.putIfAbsent(chunk.chunkId(), chunk);
            ranks.put(chunk.chunkId(), rank);
        }
    }
}
