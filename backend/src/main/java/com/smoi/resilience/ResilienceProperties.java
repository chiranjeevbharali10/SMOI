package com.smoi.resilience;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Circuit breaker settings per provider ({@code smoi.resilience.*}). */
@ConfigurationProperties("smoi.resilience")
public record ResilienceProperties(Breaker llm, Breaker embedding, Breaker reranker, Breaker google) {

    /**
     * @param failureRateThreshold       percentage of failed calls in the window that opens the breaker
     * @param slidingWindow              how many recent calls the failure rate is computed over
     * @param minimumCalls               no decision is made before this many calls
     * @param waitInOpen                 how long the breaker rejects calls before trying again
     * @param permittedCallsInHalfOpen   trial calls let through after the wait; if they succeed it closes
     */
    public record Breaker(int failureRateThreshold, int slidingWindow, int minimumCalls, Duration waitInOpen,
                          int permittedCallsInHalfOpen) {
    }
}
