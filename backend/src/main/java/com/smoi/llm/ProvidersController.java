package com.smoi.llm;

import java.util.Optional;

import com.smoi.embedding.EmbeddingProvider;
import com.smoi.retrieval.rerank.Reranker;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Which providers are active, and whether document text leaves the machine (NFR-04.05).
 * The desktop settings screen shows this.
 */
@RestController
public class ProvidersController {

    private final LlmProvider llm;
    private final EmbeddingProvider embeddings;
    private final Optional<Reranker> reranker;

    public ProvidersController(LlmProvider llm, EmbeddingProvider embeddings, Optional<Reranker> reranker) {
        this.llm = llm;
        this.embeddings = embeddings;
        this.reranker = reranker;
    }

    public record ProvidersResponse(Llm llm, Embedding embedding, Rerank reranker) {
    }

    /** @param hosted true if prompts (question plus allowed documents' text) are sent off the machine */
    public record Llm(String provider, String model, boolean hosted) {
    }

    /** Every embedding provider SMOI has today runs locally. */
    public record Embedding(String model, boolean hosted) {
    }

    public record Rerank(boolean enabled, String model, boolean hosted) {
    }

    @GetMapping("/api/settings/providers")
    public ProvidersResponse providers() {
        return new ProvidersResponse(
                new Llm(llm.providerId(), llm.model(), llm.hosted()),
                new Embedding(embeddings.modelId(), false),
                new Rerank(reranker.isPresent(), reranker.map(Reranker::modelId).orElse(null), false));
    }
}
