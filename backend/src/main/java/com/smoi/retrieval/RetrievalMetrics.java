package com.smoi.retrieval;

import java.time.Duration;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Component;

/**
 * Per-stage retrieval latency ({@code smoi_retrieval_stage_seconds}, tagged by stage and mode) and
 * how often retrieval had to fall back to keyword-only search.
 */
@Component
public class RetrievalMetrics {

    private final MeterRegistry registry;

    public RetrievalMetrics(MeterRegistry registry) {
        this.registry = registry;
    }

    void record(RetrievalMode mode, RetrievalResult.Timings t, boolean fellBack) {
        String m = mode.value();
        if (mode != RetrievalMode.KEYWORD) {
            timer("embed", m).record(Duration.ofMillis(t.embedMs()));
        }
        if (mode != RetrievalMode.VECTOR || fellBack) {
            timer("keyword", m).record(Duration.ofMillis(t.keywordMs()));
        }
        if (mode != RetrievalMode.KEYWORD && !fellBack) {
            timer("vector", m).record(Duration.ofMillis(t.vectorMs()));
        }
        if (mode == RetrievalMode.HYBRID_RERANK) {
            timer("rerank", m).record(Duration.ofMillis(t.rerankMs()));
        }
        timer("total", m).record(Duration.ofMillis(t.totalMs()));
        if (fellBack) {
            Counter.builder("smoi.retrieval.fallback").tag("mode", m).tag("reason", "embedding_unavailable")
                    .register(registry).increment();
        }
    }

    private Timer timer(String stage, String mode) {
        return Timer.builder("smoi.retrieval.stage").tag("stage", stage).tag("mode", mode).register(registry);
    }
}
