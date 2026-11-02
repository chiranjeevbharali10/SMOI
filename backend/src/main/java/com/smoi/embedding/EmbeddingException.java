package com.smoi.embedding;

/**
 * The embedding provider failed: unreachable, timed out, or returned an unusable response.
 * Ingestion treats this as temporary and retries with backoff.
 */
public class EmbeddingException extends RuntimeException {

    public EmbeddingException(String message) {
        super(message);
    }

    public EmbeddingException(String message, Throwable cause) {
        super(message, cause);
    }
}
