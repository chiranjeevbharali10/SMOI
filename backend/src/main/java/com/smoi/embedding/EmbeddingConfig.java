package com.smoi.embedding;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Picks the embedding provider from {@code smoi.embedding.provider}. Exactly one bean is
 * created; everything else depends on the {@link EmbeddingProvider} interface.
 */
@Configuration
public class EmbeddingConfig {

    @Bean
    @ConditionalOnProperty(name = "smoi.embedding.provider", havingValue = "ollama")
    EmbeddingProvider ollamaEmbeddingProvider(EmbeddingProperties props) {
        return new OllamaEmbeddingProvider(props.ollama());
    }

    @Bean
    @ConditionalOnProperty(name = "smoi.embedding.provider", havingValue = "hashing")
    EmbeddingProvider hashingEmbeddingProvider() {
        return new HashingEmbeddingProvider();
    }
}
