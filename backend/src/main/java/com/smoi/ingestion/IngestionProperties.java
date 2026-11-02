package com.smoi.ingestion;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Settings from {@code smoi.ingestion.*}.
 *
 * @param workers      worker threads in this process; 0 runs no workers (API only)
 * @param pollInterval how long an idle worker waits before checking the queue again
 * @param lease        how long a claimed job stays reserved without a sign of life from its
 *                     worker. Workers renew it between steps; if a worker dies, the job becomes
 *                     claimable again when the lease runs out.
 * @param maxAttempts  attempts before a job is moved to the dead-letter state
 * @param backoffBase  wait before the first retry; doubles on every further retry
 * @param backoffMax   upper limit for the wait between retries
 */
@ConfigurationProperties(prefix = "smoi.ingestion")
public record IngestionProperties(
        int workers, Duration pollInterval, Duration lease, int maxAttempts, Duration backoffBase, Duration backoffMax) {

    public IngestionProperties {
        if (workers < 0) {
            throw new IllegalStateException("smoi.ingestion.workers must be 0 or more");
        }
        if (maxAttempts < 1) {
            throw new IllegalStateException("smoi.ingestion.max-attempts must be at least 1");
        }
        if (lease.isNegative() || lease.isZero() || pollInterval.isNegative() || pollInterval.isZero()) {
            throw new IllegalStateException("smoi.ingestion.lease and poll-interval must be positive");
        }
    }

    /**
     * Exponential backoff: the wait before retrying after the given (1-based) failed attempt.
     * base, 2 x base, 4 x base, ... capped at {@code backoffMax}. Waiting longer each time gives a
     * struggling dependency (for example an overloaded Ollama) room to recover instead of being
     * hit again immediately.
     */
    public Duration backoffAfter(int failedAttempt) {
        int doublings = Math.min(failedAttempt - 1, 30); // 2^30 x base is far past any sane cap
        Duration delay = backoffBase.multipliedBy(1L << doublings);
        return delay.compareTo(backoffMax) > 0 ? backoffMax : delay;
    }
}
