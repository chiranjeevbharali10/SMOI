package com.smoi.retrieval.rerank;

import com.smoi.resilience.ProviderTimeouts;
import java.net.http.HttpClient;
import java.util.List;

import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/** Calls the Python cross-encoder sidecar ({@code sidecars/reranker}): {@code POST /rerank}. */
public class HttpReranker implements Reranker {

    private final RestClient http;
    private volatile String modelId = "cross-encoder (sidecar)";

    public HttpReranker(RerankProperties props) {
        HttpClient client = HttpClient.newBuilder().connectTimeout(ProviderTimeouts.CONNECT).build();
        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(client);
        requestFactory.setReadTimeout(props.timeout());
        this.http = RestClient.builder().baseUrl(props.baseUrl()).requestFactory(requestFactory).build();
    }

    @Override
    public String modelId() {
        return modelId;
    }

    @Override
    public List<Double> score(String query, List<String> passages) {
        RerankResponse response;
        try {
            response = http.post().uri("/rerank")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(new RerankRequest(query, passages))
                    .retrieve()
                    .body(RerankResponse.class);
        } catch (RestClientException e) {
            throw new RerankerUnavailableException("Reranker request failed: " + e.getMessage(), e);
        }
        if (response == null || response.scores() == null || response.scores().size() != passages.size()) {
            throw new RerankerUnavailableException("Reranker returned the wrong number of scores");
        }
        if (response.model() != null) {
            modelId = response.model();
        }
        return response.scores();
    }

    record RerankRequest(String query, List<String> passages) {
    }

    record RerankResponse(String model, List<Double> scores) {
    }
}
