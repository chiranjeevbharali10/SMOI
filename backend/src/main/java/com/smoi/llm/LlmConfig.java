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

    @Bean
    @ConditionalOnProperty(name = "smoi.llm.provider", havingValue = "anthropic")
    LlmProvider anthropicLlmProvider(LlmProperties props) {
        return new AnthropicLlmProvider(props.anthropic(), props.maxOutputTokens());
    }
}
