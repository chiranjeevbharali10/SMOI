package com.smoi.llm;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Settings from {@code smoi.llm.*}.
 *
 * @param provider        {@code ollama} (local, default) or {@code anthropic} (hosted, opt-in)
 * @param maxOutputTokens upper limit for one reply
 */
@ConfigurationProperties(prefix = "smoi.llm")
public record LlmProperties(String provider, int maxOutputTokens, Ollama ollama, Anthropic anthropic) {

    /**
     * @param numCtx context window passed to Ollama. Set explicitly: Ollama's default is small,
     *               and a prompt longer than it is truncated without an error.
     */
    public record Ollama(String baseUrl, String model, int numCtx, Duration timeout) {
    }

    /**
     * @param apiKey           from ANTHROPIC_API_KEY; only required when this provider is selected
     * @param effort           {@code low}, {@code medium} or {@code high}; how much the model thinks
     * @param maxPromptTokens  prompt budget. Far below the 1M context on purpose: Claude Haiku 5.5
     *                         is billed at a higher rate for prompts over 100K tokens.
     */
    public record Anthropic(String apiKey, String model, String effort, int maxPromptTokens, Duration timeout) {
    }
}
