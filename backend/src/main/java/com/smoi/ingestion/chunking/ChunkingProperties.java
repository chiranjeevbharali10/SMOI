package com.smoi.ingestion.chunking;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Settings from {@code smoi.chunking.*}. Phase 3 compares different values, so they are
 * configuration rather than constants.
 *
 * @param maxTokens     target upper size of a chunk, in estimated tokens
 * @param overlapTokens how much of the end of one chunk is repeated at the start of the next
 */
@ConfigurationProperties(prefix = "smoi.chunking")
public record ChunkingProperties(int maxTokens, int overlapTokens) {

    public ChunkingProperties {
        if (maxTokens < 50) {
            throw new IllegalStateException("smoi.chunking.max-tokens must be at least 50");
        }
        if (overlapTokens < 0 || overlapTokens >= maxTokens / 2) {
            throw new IllegalStateException("smoi.chunking.overlap-tokens must be between 0 and half of max-tokens");
        }
    }
}
