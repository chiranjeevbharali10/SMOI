package com.smoi.embedding;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Settings from {@code smoi.embedding.*}.
 *
 * @param provider  which implementation to use: {@code ollama} or {@code hashing}
 * @param batchSize how many chunks to send per request to the provider
 * @param ollama    settings for the Ollama provider
 */
@ConfigurationProperties(prefix = "smoi.embedding")
public record EmbeddingProperties(String provider, int batchSize, Ollama ollama) {

    public EmbeddingProperties {
        if (batchSize < 1) {
            throw new IllegalStateException("smoi.embedding.batch-size must be at least 1");
        }
    }

    /**
     * @param baseUrl        where Ollama listens, for example {@code http://localhost:11434}
     * @param model          embedding model name, for example {@code nomic-embed-text}
     * @param documentPrefix text put before every document passage (model specific, may be empty)
     * @param queryPrefix    text put before every search query (model specific, may be empty)
     * @param timeout        how long one request may take before it counts as failed
     */
    public record Ollama(String baseUrl, String model, String documentPrefix, String queryPrefix, Duration timeout) {

        public Ollama {
            documentPrefix = documentPrefix == null ? "" : documentPrefix;
            queryPrefix = queryPrefix == null ? "" : queryPrefix;
        }
    }
}
