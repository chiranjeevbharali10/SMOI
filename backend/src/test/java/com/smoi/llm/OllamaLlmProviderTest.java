package com.smoi.llm;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The Ollama chat provider against a fake server that streams NDJSON like Ollama does. */
class OllamaLlmProviderTest {

    private HttpServer server;
    private final AtomicReference<String> requestBody = new AtomicReference<>();
    private volatile String responseBody;
    private volatile int status = 200;

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/chat", exchange -> {
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] body = responseBody.getBytes(StandardCharsets.UTF_8);
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

    private OllamaLlmProvider provider(int numCtx, int maxOutput) {
        return new OllamaLlmProvider(new LlmProperties.Ollama("http://127.0.0.1:" + server.getAddress().getPort(),
                "qwen3.5:2b-q4_K_M", numCtx, Duration.ofSeconds(5)), maxOutput);
    }

    private static String stream(String... pieces) {
        StringBuilder sb = new StringBuilder();
        for (String p : pieces) {
            sb.append("{\"message\":{\"role\":\"assistant\",\"content\":\"").append(p).append("\"},\"done\":false}\n");
        }
        return sb.toString();
    }

    @Test
    void streamsTextAndSendsContextSizeWithThinkingOff() {
        responseBody = stream("It opens ", "at nine [S1].")
                + "{\"done\":true,\"done_reason\":\"stop\",\"prompt_eval_count\":300,\"eval_count\":8}\n";
        List<String> deltas = new ArrayList<>();

        LlmResult result = provider(8192, 1024).generate(new LlmRequest("system", "user"), deltas::add);

        assertThat(deltas).containsExactly("It opens ", "at nine [S1].");
        assertThat(result.text()).isEqualTo("It opens at nine [S1].");
        assertThat(result.stop()).isEqualTo(LlmResult.Stop.COMPLETE);
        assertThat(result.inputTokens()).isEqualTo(300);
        assertThat(requestBody.get()).contains("\"think\":false").contains("\"num_ctx\":8192")
                .contains("\"num_predict\":1024").doesNotContain("temperature");
    }

    @Test
    void aPromptThatFilledTheContextIsAnErrorNotASilentTruncation() {
        responseBody = stream("Partial") + "{\"done\":true,\"done_reason\":\"stop\",\"prompt_eval_count\":7900,\"eval_count\":2}\n";

        assertThatThrownBy(() -> provider(8192, 1024).generate(new LlmRequest("s", "u"), t -> { }))
                .isInstanceOf(ContextOverflowException.class);
    }

    @Test
    void hittingTheOutputLimitIsReported() {
        responseBody = stream("Long") + "{\"done\":true,\"done_reason\":\"length\",\"prompt_eval_count\":10,\"eval_count\":1024}\n";

        assertThat(provider(8192, 1024).generate(new LlmRequest("s", "u"), t -> { }).stop())
                .isEqualTo(LlmResult.Stop.MAX_TOKENS);
    }

    @Test
    void anErrorFromOllamaBecomesUnavailable() {
        status = 404;
        responseBody = "{\"error\":\"model not found\"}";

        assertThatThrownBy(() -> provider(8192, 1024).generate(new LlmRequest("s", "u"), t -> { }))
                .isInstanceOf(LlmUnavailableException.class).hasMessageContaining("model not found");
    }

    @Test
    void theBudgetLeavesRoomForTheOutput() {
        assertThat(provider(8192, 2048).maxPromptTokens()).isEqualTo(6144);
        assertThatThrownBy(() -> provider(1024, 2048)).isInstanceOf(IllegalStateException.class);
    }
}
