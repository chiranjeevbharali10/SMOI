package com.smoi.llm;

import java.time.Duration;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Generation latency, tokens and estimated cost per LLM call, tagged by provider and model:
 * <ul>
 *   <li>{@code smoi_llm_generation_seconds} and {@code smoi_llm_first_token_seconds}</li>
 *   <li>{@code smoi_llm_tokens_total{direction=input|output}}</li>
 *   <li>{@code smoi_llm_cost_usd} (a summary: sum = total spend, count = calls): an estimate from
 *       the configured prices, not a bill. A local model costs nothing.</li>
 * </ul>
 */
@Component
public class LlmMetrics {

    private final MeterRegistry registry;
    private final Prices prices;

    public LlmMetrics(MeterRegistry registry, Prices prices) {
        this.registry = registry;
        this.prices = prices;
    }

    /** USD per million tokens for the hosted provider ({@code smoi.cost.*}). */
    @ConfigurationProperties("smoi.cost")
    public record Prices(double anthropicInputPerMtok, double anthropicOutputPerMtok) {
    }

    public void record(String provider, String model, LlmResult result) {
        Timer.builder("smoi.llm.generation").tag("provider", provider).tag("model", model).register(registry)
                .record(Duration.ofMillis(result.totalMs()));
        Timer.builder("smoi.llm.first.token").tag("provider", provider).tag("model", model).register(registry)
                .record(Duration.ofMillis(result.firstTokenMs()));
        tokens(provider, model, "input").increment(result.inputTokens());
        tokens(provider, model, "output").increment(result.outputTokens());
        DistributionSummary.builder("smoi.llm.cost").baseUnit("usd").tag("provider", provider).tag("model", model)
                .register(registry).record(estimateUsd(provider, result.inputTokens(), result.outputTokens()));
    }

    double estimateUsd(String provider, long inputTokens, long outputTokens) {
        if (!"anthropic".equals(provider)) {
            return 0;
        }
        return (inputTokens * prices.anthropicInputPerMtok() + outputTokens * prices.anthropicOutputPerMtok()) / 1_000_000.0;
    }

    private Counter tokens(String provider, String model, String direction) {
        return Counter.builder("smoi.llm.tokens").tag("provider", provider).tag("model", model)
                .tag("direction", direction).register(registry);
    }
}
