package com.smoi.llm;

import java.util.function.Consumer;

/**
 * A chat model that writes answers. Configuration picks the implementation
 * ({@code smoi.llm.provider}); nothing outside this package names one.
 */
public interface LlmProvider {

    /** {@code ollama} or {@code anthropic}; recorded with every answer and benchmark. */
    String providerId();

    String model();

    /**
     * True if the text leaves the machine. Only documents the user allowed for hosted LLMs are
     * sent to such a provider.
     */
    boolean hosted();

    /**
     * How many prompt tokens a request may use. Prompts are built to fit inside this, and
     * chunks that don't fit are dropped and reported, never cut off silently.
     */
    int maxPromptTokens();

    /**
     * Generates a reply. {@code onText} receives text as it arrives (for streaming); pass a no-op
     * to just wait for the result.
     *
     * @throws LlmUnavailableException  if the provider can't be reached or fails
     * @throws ContextOverflowException if the prompt didn't fit after all
     */
    LlmResult generate(LlmRequest request, Consumer<String> onText);
}
