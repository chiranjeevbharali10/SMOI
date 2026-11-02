package com.smoi.embedding;

import java.net.http.HttpClient;
import java.util.ArrayList;
import java.util.List;

import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/**
 * Embeds text with a model served by a local Ollama instance, so document text never leaves
 * the machine. Calls Ollama's {@code POST /api/embed}, which accepts a batch of inputs.
 *
 * <p>Models such as nomic-embed-text were trained with a task prefix ("search_document: " or
 * "search_query: ") in front of the text; leaving it out lowers retrieval quality. The
 * prefixes are configuration because they differ per model.
 */
public class OllamaEmbeddingProvider implements EmbeddingProvider {

    private final RestClient http;
    private final EmbeddingProperties.Ollama props;

    public OllamaEmbeddingProvider(EmbeddingProperties.Ollama props) {
        if (props.baseUrl() == null || props.baseUrl().isBlank() || props.model() == null || props.model().isBlank()) {
            throw new IllegalStateException("smoi.embedding.ollama.base-url and .model must be set");
        }
        this.props = props;
        HttpClient client = HttpClient.newBuilder().connectTimeout(props.timeout()).build();
        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(client);
        requestFactory.setReadTimeout(props.timeout());
        this.http = RestClient.builder().baseUrl(props.baseUrl()).requestFactory(requestFactory).build();
    }

    @Override
    public String modelId() {
        return "ollama/" + props.model();
    }

    @Override
    public List<float[]> embedDocuments(List<String> texts) {
        if (texts.isEmpty()) {
            return List.of();
        }
        List<String> inputs = new ArrayList<>(texts.size());
        for (String text : texts) {
            inputs.add(props.documentPrefix() + text);
        }
        return embed(inputs);
    }

    @Override
    public float[] embedQuery(String text) {
        return embed(List.of(props.queryPrefix() + text)).getFirst();
    }

    private List<float[]> embed(List<String> inputs) {
        EmbedResponse response;
        try {
            response = http.post().uri("/api/embed")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(new EmbedRequest(props.model(), inputs))
                    .retrieve()
                    .body(EmbedResponse.class);
        } catch (RestClientException e) {
            // Covers connection refused, timeouts, and 4xx/5xx (for example "model not found"
            // when the model hasn't been pulled yet). All can be fixed without changing the
            // document, so the caller retries.
            throw new EmbeddingException("Ollama embedding request failed: " + e.getMessage(), e);
        }
        if (response == null || response.embeddings() == null || response.embeddings().size() != inputs.size()) {
            throw new EmbeddingException("Ollama returned " + (response == null || response.embeddings() == null
                    ? "no embeddings" : response.embeddings().size() + " embeddings")
                    + " for " + inputs.size() + " inputs");
        }
        // The ingestion pipeline checks the vector size for every provider.
        return response.embeddings();
    }

    /** {@code truncate}: if a passage is longer than the model's context, cut it instead of failing. */
    record EmbedRequest(String model, List<String> input, boolean truncate) {
        EmbedRequest(String model, List<String> input) {
            this(model, input, true);
        }
    }

    record EmbedResponse(List<float[]> embeddings) {
    }
}
