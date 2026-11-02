package com.smoi.llm;

import java.time.Duration;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class LlmMetricsTest {

    private final SimpleMeterRegistry registry = new SimpleMeterRegistry();
    private final LlmMetrics metrics = new LlmMetrics(registry, new LlmMetrics.Prices(0.10, 0.50));

    @Test
    void hostedCostIsTokensTimesPricePerMillion() {
        // 10,000 input tokens at $0.10/M + 2,000 output tokens at $0.50/M = $0.001 + $0.001
        assertThat(metrics.estimateUsd("anthropic", 10_000, 2_000)).isCloseTo(0.002, within(1e-12));
    }

    @Test
    void localModelsCostNothing() {
        assertThat(metrics.estimateUsd("ollama", 10_000, 2_000)).isZero();
        assertThat(metrics.estimateUsd("stub", 10_000, 2_000)).isZero();
    }

    @Test
    void recordsTokensAndCostPerProviderAndModel() {
        metrics.record("anthropic", "claude-haiku-5-5",
                new LlmResult("x", LlmResult.Stop.COMPLETE, null, null, 1_000_000, 0, 100, 900));

        assertThat(registry.get("smoi.llm.tokens").tag("direction", "input").counter().count()).isEqualTo(1_000_000);
        assertThat(registry.get("smoi.llm.cost").tag("model", "claude-haiku-5-5").summary().totalAmount()).isCloseTo(0.10, within(1e-9));
        assertThat(registry.get("smoi.llm.generation").timer().count()).isEqualTo(1);
    }

    @Test
    void stubProviderAnswersWithACitationAfterItsLatency() {
        StubLlmProvider stub = new StubLlmProvider(Duration.ofMillis(20));
        StringBuilder streamed = new StringBuilder();

        LlmResult result = stub.generate(new LlmRequest("system", "user question"), streamed::append);

        assertThat(result.text()).contains("[S1]");
        assertThat(streamed.toString()).isEqualTo(result.text());
        assertThat(result.totalMs()).isGreaterThanOrEqualTo(20);
        assertThat(stub.providerId()).isEqualTo("stub");
    }
}
