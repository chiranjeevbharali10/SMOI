package com.smoi.ingestion;

import java.util.UUID;

/**
 * A job claimed by a worker.
 *
 * @param attempts   includes the current attempt (the claim increments it)
 * @param leaseToken proves this worker still owns the job; every update checks it
 * @param requestId  the request that created the job, for its log lines (may be null)
 */
public record IngestionJob(
        UUID id, UUID userId, UUID documentId, int documentVersion, int attempts, int maxAttempts, UUID leaseToken,
        String requestId) {
}
