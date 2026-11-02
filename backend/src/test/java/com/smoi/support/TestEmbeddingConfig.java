package com.smoi.support;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/**
 * Test doubles for the model providers in integration tests: {@link FaultInjectingEmbeddingProvider}
 * for embeddings and {@link ScriptedLlmProvider} for the LLM.
 */
@TestConfiguration
public class TestEmbeddingConfig {

    @Bean
    @Primary
    FaultInjectingEmbeddingProvider faultInjectingEmbeddingProvider() {
        return new FaultInjectingEmbeddingProvider();
    }

    @Bean
    @Primary
    ScriptedLlmProvider scriptedLlmProvider() {
        return new ScriptedLlmProvider();
    }
}
