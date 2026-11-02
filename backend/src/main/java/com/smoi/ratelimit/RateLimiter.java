package com.smoi.ratelimit;

import java.util.UUID;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Per-user token bucket rate limiting, stored in Postgres.
 *
 * <p>Each user has a bucket per kind of request holding up to {@code capacity} tokens, refilled
 * continuously at {@code refillPerMinute}. A request takes one token; with none left it is
 * rejected. Capacity allows short bursts, the refill rate caps the sustained rate.
 *
 * <p>The whole check is one SQL statement. The {@code INSERT ... ON CONFLICT DO UPDATE} locks the
 * user's bucket row, works out the refill from the time since the last request, and takes a token
 * if there is one. Two concurrent requests, even on different backend instances, queue on that row
 * lock, so they can't both spend the last token. Postgres's clock is the only clock used, so
 * instance clocks don't need to agree.
 */
@Component
public class RateLimiter {

    private final JdbcClient jdbc;
    private final RateLimitProperties props;
    private final MeterRegistry meters;

    public RateLimiter(JdbcClient jdbc, RateLimitProperties props, MeterRegistry meters) {
        this.jdbc = jdbc;
        this.props = props;
        this.meters = meters;
    }

    /**
     * @param retryAfterSeconds when a token will next be available (0 if allowed)
     */
    public record Decision(boolean allowed, long retryAfterSeconds) {
    }

    public Decision tryAcquire(UUID userId, String bucket) {
        if (!props.enabled()) {
            return new Decision(true, 0);
        }
        RateLimitProperties.Limit limit = props.limit(bucket);
        double perSecond = limit.refillPerMinute() / 60.0;
        // "available" = tokens left last time plus refill since then, capped at capacity.
        String available = "LEAST(:capacity, b.tokens + EXTRACT(EPOCH FROM (now() - b.refilled_at)) * :perSecond)";
        Row row = jdbc.sql("""
                        INSERT INTO rate_limit_buckets AS b (user_id, bucket, tokens, refilled_at, allowed)
                        VALUES (:userId, :bucket, :capacity - 1, now(), true)
                        ON CONFLICT (user_id, bucket) WHERE deleted_at IS NULL DO UPDATE
                           SET tokens      = CASE WHEN %1$s >= 1 THEN %1$s - 1 ELSE %1$s END,
                               allowed     = %1$s >= 1,
                               refilled_at = now()
                        RETURNING allowed, tokens
                        """.formatted(available))
                .param("userId", userId)
                .param("bucket", bucket)
                .param("capacity", (double) limit.capacity())
                .param("perSecond", perSecond)
                .query(Row.class)
                .single();
        if (row.allowed()) {
            return new Decision(true, 0);
        }
        Counter.builder("smoi.rate.limit.rejected").tag("bucket", bucket).register(meters).increment();
        long retryAfter = (long) Math.ceil((1 - row.tokens()) / perSecond);
        return new Decision(false, Math.max(1, retryAfter));
    }

    private record Row(boolean allowed, double tokens) {
    }
}
