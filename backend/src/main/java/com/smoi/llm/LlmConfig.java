package com.smoi.llm;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Picks the LLM provider from {@code smoi.llm.provider}. */
@Configuration
public class LlmConfig {

    @Bean
    @ConditionalOnProperty(name = "smoi.llm.provider", havingValue = "ollama")
    LlmProvider ollamaLlmProvider(LlmProperties props) {
        return new OllamaLlmProvider(props.ollama(), props.maxOutputTokens());
    }

    /** Load tests only: a fixed-latency fake (see {@link StubLlmProvider}). */
    @Bean
    @ConditionalOnProperty(name = "smoi.llm.provider", havingValue = "stub")
    LlmProvider stubLlmProvider(@org.springframework.beans.factory.annotation.Value("${smoi.llm.stub.latency:PT0.2S}") java.time.Duration latency) {
        return new StubLlmProvider(latency);
    }

    @Bean
    @ConditionalOnProperty(name = "smoi.llm.provider", havingValue = "anthropic")
    LlmProvider anthropicLlmProvider(LlmProperties props) {
        return new AnthropicLlmProvider(props.anthropic(), props.maxOutputTokens());
    }
}
