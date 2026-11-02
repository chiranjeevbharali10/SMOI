package com.smoi.support;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/** Replaces the configured embedding provider with {@link FaultInjectingEmbeddingProvider} in integration tests. */
@TestConfiguration
public class TestEmbeddingConfig {

    @Bean
    @Primary
    FaultInjectingEmbeddingProvider faultInjectingEmbeddingProvider() {
        return new FaultInjectingEmbeddingProvider();
    }
}
