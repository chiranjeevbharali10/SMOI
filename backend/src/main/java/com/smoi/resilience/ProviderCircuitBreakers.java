package com.smoi.resilience;

import java.util.function.Supplier;

import com.smoi.embedding.EmbeddingException;
import com.smoi.google.GoogleExceptions;
import com.smoi.llm.LlmUnavailableException;
import com.smoi.retrieval.rerank.RerankerUnavailableException;
import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
import io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry;
import io.github.resilience4j.micrometer.tagged.TaggedCircuitBreakerMetrics;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Circuit breakers around the three model providers (NFR-02.07).
 *
 * <p>Without a breaker, every request to a provider that is down waits for the full timeout
 * (up to minutes for the LLM) and ties up a thread. A breaker counts recent failures; once too
 * many fail it "opens" and rejects calls immediately, so callers can fall back at once. After a
 * wait it lets a few trial calls through ("half-open") and closes again if they succeed.
 *
 * <p>Only provider outages count as failures: {@link LlmUnavailableException},
 * {@link EmbeddingException} and {@link RerankerUnavailableException}. A refusal or an
 * over-long prompt is the request's problem, not the provider's, so it doesn't count. A rejected
 * call is rethrown as the same exception type, so callers have one error to handle.
 *
 * <p>State is per backend instance. That is deliberate: each instance learns about an outage from
 * its own calls, and keeping no shared state means no extra infrastructure (NFR-06.01 concerns user
 * state, which this isn't).
 */
@Component
public class ProviderCircuitBreakers {

    private static final Logger log = LoggerFactory.getLogger(ProviderCircuitBreakers.class);

    private final CircuitBreakerRegistry registry = CircuitBreakerRegistry.ofDefaults();
    private final CircuitBreaker llm;
    private final CircuitBreaker embedding;
    private final CircuitBreaker reranker;
    private final CircuitBreaker google;

    public ProviderCircuitBreakers(ResilienceProperties props, MeterRegistry meters) {
        this.llm = create("llm", props.llm(), LlmUnavailableException.class);
        this.embedding = create("embedding", props.embedding(), EmbeddingException.class);
        this.reranker = create("reranker", props.reranker(), RerankerUnavailableException.class);
        this.google = create("google", props.google(), GoogleExceptions.Unavailable.class);
        // Publishes resilience4j_circuitbreaker_state and call counts to Prometheus.
        TaggedCircuitBreakerMetrics.ofCircuitBreakerRegistry(registry).bindTo(meters);
    }

    private CircuitBreaker create(String name, ResilienceProperties.Breaker b, Class<? extends Throwable> failure) {
        CircuitBreakerConfig config = CircuitBreakerConfig.custom()
                .slidingWindowType(CircuitBreakerConfig.SlidingWindowType.COUNT_BASED)
                .slidingWindowSize(b.slidingWindow())
                .minimumNumberOfCalls(b.minimumCalls())
                .failureRateThreshold(b.failureRateThreshold())
                .waitDurationInOpenState(b.waitInOpen())
                .permittedNumberOfCallsInHalfOpenState(b.permittedCallsInHalfOpen())
                .automaticTransitionFromOpenToHalfOpenEnabled(true)
                .recordExceptions(failure)
                .build();
        CircuitBreaker breaker = registry.circuitBreaker(name, config);
        breaker.getEventPublisher().onStateTransition(e ->
                log.warn("Circuit breaker {} changed state: {}", name, e.getStateTransition()));
        return breaker;
    }

    public <T> T llm(Supplier<T> call) {
        try {
            return llm.executeSupplier(call);
        } catch (CallNotPermittedException e) {
            throw new LlmUnavailableException("The LLM provider is failing, so calls are paused for a while (circuit open)", e);
        }
    }

    public <T> T embedding(Supplier<T> call) {
        try {
            return embedding.executeSupplier(call);
        } catch (CallNotPermittedException e) {
            throw new EmbeddingException("The embedding provider is failing, so calls are paused for a while (circuit open)", e);
        }
    }

    public <T> T reranker(Supplier<T> call) {
        try {
            return reranker.executeSupplier(call);
        } catch (CallNotPermittedException e) {
            throw new RerankerUnavailableException("The reranker is failing, so calls are paused for a while (circuit open)", e);
        }
    }

    /** Google Calendar and Gmail (Phase 8). Only outages count; a 404 or a reconnect doesn't. */
    public <T> T google(Supplier<T> call) {
        try {
            return google.executeSupplier(call);
        } catch (CallNotPermittedException e) {
            throw new GoogleExceptions.Unavailable("Google is failing, so SMOI is pausing calls to it for a while.", e);
        }
    }

    public CircuitBreaker.State llmState() {
        return llm.getState();
    }

    public CircuitBreaker.State embeddingState() {
        return embedding.getState();
    }

    /** Closes every breaker and forgets past calls. For tests. */
    public void reset() {
        llm.reset();
        embedding.reset();
        reranker.reset();
        google.reset();
    }
}
