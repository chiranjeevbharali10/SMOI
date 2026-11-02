package com.smoi.embedding;

import java.util.List;

/**
 * Turns text into embedding vectors: lists of numbers where texts with similar meaning end
 * up close together. Retrieval compares a query's vector with chunk vectors to find
 * passages about the same thing, even when they use different words.
 *
 * <p>Implementations are chosen by {@code smoi.embedding.provider}; no code outside this
 * package names a concrete provider.
 */
public interface EmbeddingProvider {

    /** Vector size the database column holds ({@code vector(768)} in V4__document_chunks.sql). */
    int DIMENSIONS = 768;

    /** Identifies the model, stored next to every vector. Vectors from different models can't be compared. */
    String modelId();

    /**
     * Embeds document passages, one vector per input, in input order.
     *
     * @throws EmbeddingException if the provider can't be reached or returns something unusable
     */
    List<float[]> embedDocuments(List<String> texts);

    /**
     * Embeds a search query. Some models are trained with different prefixes for queries and
     * documents, so this is a separate method from {@link #embedDocuments}. Used from Phase 2.
     */
    float[] embedQuery(String text);
}
