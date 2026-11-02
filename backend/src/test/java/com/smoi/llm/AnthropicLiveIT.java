package com.smoi.llm;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Checks the features SMOI relies on against the real Claude API: a system prompt, streaming,
 * the effort setting without sampling parameters, and the stop reason. Skipped unless
 * ANTHROPIC_API_KEY is set, because it costs money (a fraction of a cent per run on Haiku 5.5).
 */
@EnabledIfEnvironmentVariable(named = "ANTHROPIC_API_KEY", matches = ".+")
class AnthropicLiveIT {

    @Test
    void groundedAnswerStreamsWithACitationAndCompletes() {
        String model = System.getenv().getOrDefault("ANTHROPIC_MODEL", "claude-haiku-5-5");
        AnthropicLlmProvider provider = new AnthropicLlmProvider(new LlmProperties.Anthropic(
                System.getenv("ANTHROPIC_API_KEY"), model, "low", 32000, Duration.ofSeconds(60)), 1024);
        List<String> deltas = new ArrayList<>();

        LlmResult result = provider.generate(new LlmRequest(
                "Answer only from the sources. Cite the source id in square brackets, like [S1].",
                "<sources>\n<source id=\"S1\">\nThe Larkspur garden opens at nine on Saturdays.\n</source>\n</sources>\n\n"
                        + "Question: When does the garden open on Saturdays?"), deltas::add);

        assertThat(result.stop()).isEqualTo(LlmResult.Stop.COMPLETE);
        assertThat(result.text()).contains("[S1]");
        assertThat(deltas).isNotEmpty();
        assertThat(String.join("", deltas)).isEqualTo(result.text());
        assertThat(result.inputTokens()).isPositive();
    }
}
