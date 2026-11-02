package com.smoi.embedding;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Checks the real HTTP request and response handling against a small fake Ollama server,
 * so the test doesn't need to download a model.
 */
class OllamaEmbeddingProviderTest {

    private HttpServer server;
    private final AtomicReference<String> lastRequestBody = new AtomicReference<>();
    private volatile int status = 200;
    private volatile String responseBody;

    @BeforeEach
    void startFakeOllama() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/embed", exchange -> {
            lastRequestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] body = responseBody.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private OllamaEmbeddingProvider provider() {
        return new OllamaEmbeddingProvider(new EmbeddingProperties.Ollama(
                "http://127.0.0.1:" + server.getAddress().getPort(), "nomic-embed-text",
                "search_document: ", "search_query: ", Duration.ofSeconds(5)));
    }

    private static String vectorJson(float value) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < EmbeddingProvider.DIMENSIONS; i++) {
            sb.append(i == 0 ? "" : ",").append(value);
        }
        return sb.append(']').toString();
    }

    @Test
    void sendsABatchWithTheDocumentPrefixAndReturnsVectorsInOrder() {
        responseBody = "{\"model\":\"nomic-embed-text\",\"embeddings\":[" + vectorJson(0.1f) + "," + vectorJson(0.2f) + "]}";

        List<float[]> vectors = provider().embedDocuments(List.of("first chunk", "second chunk"));

        assertThat(vectors).hasSize(2);
        assertThat(vectors.get(0)[0]).isEqualTo(0.1f);
        assertThat(vectors.get(1)[767]).isEqualTo(0.2f);
        assertThat(lastRequestBody.get())
                .contains("\"model\":\"nomic-embed-text\"")
                .contains("\"search_document: first chunk\"", "\"search_document: second chunk\"")
                .contains("\"truncate\":true");
    }

    @Test
    void queriesUseTheQueryPrefix() {
        responseBody = "{\"embeddings\":[" + vectorJson(0.3f) + "]}";

        float[] vector = provider().embedQuery("where are the frogs?");

        assertThat(vector).hasSize(EmbeddingProvider.DIMENSIONS);
        assertThat(lastRequestBody.get()).contains("\"search_query: where are the frogs?\"");
    }

    @Test
    void anErrorResponseBecomesAnEmbeddingException() {
        status = 404;
        responseBody = "{\"error\":\"model \\\"nomic-embed-text\\\" not found, try pulling it first\"}";

        assertThatThrownBy(() -> provider().embedDocuments(List.of("text")))
                .isInstanceOf(EmbeddingException.class)
                .hasMessageContaining("Ollama embedding request failed");
    }

    @Test
    void anUnreachableServerBecomesAnEmbeddingException() {
        OllamaEmbeddingProvider provider = provider();
        server.stop(0);

        assertThatThrownBy(() -> provider.embedDocuments(List.of("text"))).isInstanceOf(EmbeddingException.class);
    }

    @Test
    void aWrongNumberOfVectorsIsRejected() {
        responseBody = "{\"embeddings\":[" + vectorJson(0.1f) + "]}";

        assertThatThrownBy(() -> provider().embedDocuments(List.of("one", "two")))
                .isInstanceOf(EmbeddingException.class)
                .hasMessageContaining("1 embeddings for 2 inputs");
    }
}
