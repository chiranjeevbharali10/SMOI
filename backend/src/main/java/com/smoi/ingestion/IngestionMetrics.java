package com.smoi.ingestion;

import java.time.Duration;
import java.util.function.ToDoubleFunction;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Component;

/**
 * Queue gauges: {@code smoi_ingestion_queue_jobs{state=ready|backing_off|running}} and
 * {@code smoi_ingestion_queue_oldest_ready_seconds} (how long the oldest ready job has waited:
 * rising means workers can't keep up).
 *
 * <p>The gauges read the database when Prometheus scrapes. One query serves all four, and the
 * answer is reused for a few seconds so several scrapes can't hammer the database.
 */
@Component
public class IngestionMetrics {

    private static final Duration CACHE = Duration.ofSeconds(5);

    private final JobQueue queue;
    private volatile JobQueue.Depth last = new JobQueue.Depth(0, 0, 0, 0);
    private volatile long lastReadNanos = 0;

    public IngestionMetrics(JobQueue queue, MeterRegistry registry) {
        this.queue = queue;
        gauge(registry, "smoi.ingestion.queue.jobs", "ready", JobQueue.Depth::ready);
        gauge(registry, "smoi.ingestion.queue.jobs", "backing_off", JobQueue.Depth::backingOff);
        gauge(registry, "smoi.ingestion.queue.jobs", "running", JobQueue.Depth::running);
        Gauge.builder("smoi.ingestion.queue.oldest.ready", this, m -> m.depth().oldestReadySeconds())
                .baseUnit("seconds").register(registry);
    }

    private void gauge(MeterRegistry registry, String name, String state, ToDoubleFunction<JobQueue.Depth> value) {
        Gauge.builder(name, this, m -> value.applyAsDouble(m.depth())).tag("state", state).register(registry);
    }

    synchronized JobQueue.Depth depth() {
        if (System.nanoTime() - lastReadNanos > CACHE.toNanos()) {
            try {
                last = queue.depth();
            } catch (RuntimeException e) {
                // Keep the previous value: a metrics scrape must never fail because the database blinked.
            }
            lastReadNanos = System.nanoTime();
        }
        return last;
    }
}
