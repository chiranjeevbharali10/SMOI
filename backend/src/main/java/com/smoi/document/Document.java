package com.smoi.document;

import java.time.Instant;
import java.util.UUID;

/** A document's metadata. The file bytes are loaded separately, only by the ingestion worker. */
public record Document(
        UUID id,
        UUID userId,
        String filename,
        String mediaType,
        long sizeBytes,
        String contentSha256,
        int version,
        String status,
        String error,
        int chunkCount,
        Instant createdAt,
        Instant updatedAt,
        Instant indexedAt,
        boolean hostedLlmAllowed) {

    public static final String QUEUED = "queued";
    public static final String PROCESSING = "processing";
    public static final String INDEXED = "indexed";
    public static final String FAILED = "failed";
}
