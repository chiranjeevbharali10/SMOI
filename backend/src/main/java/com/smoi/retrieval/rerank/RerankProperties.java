package com.smoi.retrieval.rerank;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Settings from {@code smoi.rerank.*}.
 *
 * @param enabled    whether the reranker sidecar is configured at all. When false, the
 *                   {@code hybrid_rerank} mode answers with plain hybrid results and says so.
 * @param baseUrl    the sidecar, for example {@code http://localhost:8001}
 * @param timeout    how long to wait before giving up and using the hybrid order
 * @param candidates how many hybrid results the reranker reorders. More candidates can find a
 *                   relevant chunk that hybrid ranked low, at the cost of more latency.
 */
@ConfigurationProperties(prefix = "smoi.rerank")
public record RerankProperties(boolean enabled, String baseUrl, Duration timeout, int candidates) {

    public RerankProperties {
        if (candidates < 1 || candidates > 200) {
            throw new IllegalStateException("smoi.rerank.candidates must be between 1 and 200");
        }
    }
}
