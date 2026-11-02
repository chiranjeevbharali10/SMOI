package com.smoi.ratelimit;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Rate limits per user ({@code smoi.rate-limit.*}). */
@ConfigurationProperties("smoi.rate-limit")
public record RateLimitProperties(boolean enabled, Limit query, Limit search, Limit upload) {

    public static final String QUERY = "query";
    public static final String SEARCH = "search";
    public static final String UPLOAD = "upload";

    /**
     * @param capacity        largest burst: requests allowed back to back after a quiet period
     * @param refillPerMinute sustained rate
     */
    public record Limit(int capacity, double refillPerMinute) {

        public Limit {
            if (capacity < 1 || refillPerMinute <= 0) {
                throw new IllegalStateException("A rate limit needs capacity >= 1 and refill-per-minute > 0");
            }
        }
    }

    Limit limit(String bucket) {
        return switch (bucket) {
            case QUERY -> query;
            case SEARCH -> search;
            case UPLOAD -> upload;
            default -> throw new IllegalArgumentException("Unknown rate limit bucket " + bucket);
        };
    }
}
