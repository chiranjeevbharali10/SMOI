package com.smoi.llm;

import java.util.Optional;

import com.smoi.embedding.EmbeddingProvider;
import com.smoi.ingestion.chunking.ChunkingProperties;
import com.smoi.retrieval.rerank.Reranker;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Which providers are active, and whether document text leaves the machine (NFR-04.05).
 * The desktop settings screen shows this, and the evaluation harness records it with each run.
 */
@RestController
public class ProvidersController {

    private final LlmProvider llm;
    private final EmbeddingProvider embeddings;
    private final Optional<Reranker> reranker;
    private final ChunkingProperties chunking;

    public ProvidersController(LlmProvider llm, EmbeddingProvider embeddings, Optional<Reranker> reranker,
                               ChunkingProperties chunking) {
        this.llm = llm;
        this.embeddings = embeddings;
        this.reranker = reranker;
        this.chunking = chunking;
    }

    public record ProvidersResponse(Llm llm, Embedding embedding, Rerank reranker, Chunking chunking) {
    }

    /** @param hosted true if prompts (question plus allowed documents' text) are sent off the machine */
    public record Llm(String provider, String model, boolean hosted) {
    }

    /** Every embedding provider SMOI has today runs locally. */
    public record Embedding(String model, boolean hosted) {
    }

    public record Rerank(boolean enabled, String model, boolean hosted) {
    }

    /** The chunk size used for documents indexed from now on. Already indexed documents keep theirs. */
    public record Chunking(int maxTokens, int overlapTokens) {
    }

    @GetMapping("/api/settings/providers")
    public ProvidersResponse providers() {
        return new ProvidersResponse(
                new Llm(llm.providerId(), llm.model(), llm.hosted()),
                new Embedding(embeddings.modelId(), false),
                new Rerank(reranker.isPresent(), reranker.map(Reranker::modelId).orElse(null), false),
                new Chunking(chunking.maxTokens(), chunking.overlapTokens()));
    }
}
