package com.smoi.retrieval.rerank;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Creates the reranker only when {@code smoi.rerank.enabled=true}. Callers inject
 * {@code Optional<Reranker>}, so the rest of the system works without it.
 */
@Configuration
public class RerankConfig {

    @Bean
    @ConditionalOnProperty(name = "smoi.rerank.enabled", havingValue = "true")
    Reranker reranker(RerankProperties props) {
        return new HttpReranker(props);
    }
}
