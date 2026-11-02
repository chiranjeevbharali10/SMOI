package com.smoi.resilience;

import java.time.Duration;

/**
 * Timeouts shared by the model provider clients (NFR-02.07).
 *
 * <p>Connecting and answering are timed separately. A provider that is up answers a TCP connect in
 * milliseconds, so a short connect timeout detects a dead or unreachable host quickly. The read
 * timeouts ({@code smoi.llm.*.timeout}, {@code smoi.embedding.ollama.timeout},
 * {@code smoi.rerank.timeout}) are longer, because a CPU-only model can take minutes to generate.
 */
public final class ProviderTimeouts {

    public static final Duration CONNECT = Duration.ofSeconds(5);

    private ProviderTimeouts() {
    }
}
