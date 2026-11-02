package com.smoi.document;

import java.util.UUID;

/** A stored chunk, without its embedding vector (768 numbers aren't useful to API clients). */
public record Chunk(
        UUID id,
        UUID documentId,
        int chunkIndex,
        String content,
        Integer pageStart,
        Integer pageEnd,
        String section,
        int tokenCount,
        String embeddingModel) {
}
