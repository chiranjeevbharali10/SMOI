package com.smoi.llm;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * A chat model served by a local Ollama ({@code POST /api/chat}, streamed as one JSON object
 * per line). Nothing leaves the machine.
 *
 * <p>Two settings matter for RAG: {@code num_ctx} is set explicitly, because Ollama silently
 * truncates a prompt longer than its context; and {@code think: false}, because thinking models
 * otherwise spend time and tokens on a reasoning trace we don't show.
 */
public class OllamaLlmProvider implements LlmProvider {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final HttpClient http;
    private final LlmProperties.Ollama props;
    private final int maxOutputTokens;

    public OllamaLlmProvider(LlmProperties.Ollama props, int maxOutputTokens) {
        if (props.numCtx() <= maxOutputTokens) {
            throw new IllegalStateException("smoi.llm.ollama.num-ctx must be larger than smoi.llm.max-output-tokens");
        }
        this.props = props;
        this.maxOutputTokens = maxOutputTokens;
        this.http = HttpClient.newBuilder().connectTimeout(props.timeout()).build();
    }

    @Override
    public String providerId() {
        return "ollama";
    }

    @Override
    public String model() {
        return props.model();
    }

    @Override
    public boolean hosted() {
        return false;
    }

    @Override
    public int maxPromptTokens() {
        return props.numCtx() - maxOutputTokens;
    }

    @Override
    public LlmResult generate(LlmRequest request, Consumer<String> onText) {
        Map<String, Object> body = Map.of(
                "model", props.model(),
                "stream", true,
                "think", false,
                "messages", List.of(
                        Map.of("role", "system", "content", request.system()),
                        Map.of("role", "user", "content", request.user())),
                "options", Map.of("num_ctx", props.numCtx(), "num_predict", maxOutputTokens));
        HttpRequest httpRequest = HttpRequest.newBuilder(URI.create(props.baseUrl() + "/api/chat"))
                .timeout(props.timeout())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(JSON.writeValueAsBytes(body)))
                .build();

        long start = System.nanoTime();
        long firstTokenMs = -1;
        StringBuilder text = new StringBuilder();
        JsonNode last = null;
        try {
            HttpResponse<java.io.InputStream> response = http.send(httpRequest, HttpResponse.BodyHandlers.ofInputStream());
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
                if (response.statusCode() != 200) {
                    throw new LlmUnavailableException("Ollama returned HTTP " + response.statusCode() + ": "
                            + reader.lines().reduce("", String::concat));
                }
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.isBlank()) {
                        continue;
                    }
                    JsonNode event = JSON.readTree(line);
                    if (event.has("error")) {
                        throw new LlmUnavailableException("Ollama error: " + event.get("error").asString());
                    }
                    String delta = event.path("message").path("content").asString("");
                    if (!delta.isEmpty()) {
                        if (firstTokenMs < 0) {
                            firstTokenMs = millisSince(start);
                        }
                        text.append(delta);
                        onText.accept(delta);
                    }
                    if (event.path("done").asBoolean(false)) {
                        last = event;
                    }
                }
            }
        } catch (IOException e) {
            throw new LlmUnavailableException("Ollama request failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new LlmUnavailableException("Interrupted while waiting for Ollama", e);
        }
        if (last == null) {
            throw new LlmUnavailableException("Ollama closed the stream before finishing");
        }

        long promptTokens = last.path("prompt_eval_count").asLong(0);
        // Second line of defence after the prompt builder's estimate: if the prompt filled the
        // context, Ollama has cut it, and the answer may be missing sources.
        if (promptTokens + maxOutputTokens > props.numCtx()) {
            throw new ContextOverflowException("The prompt used " + promptTokens + " tokens, which leaves no room for "
                    + maxOutputTokens + " output tokens in the " + props.numCtx() + "-token context");
        }
        LlmResult.Stop stop = "length".equals(last.path("done_reason").asString(""))
                ? LlmResult.Stop.MAX_TOKENS : LlmResult.Stop.COMPLETE;
        return new LlmResult(text.toString(), stop, null, null, promptTokens, last.path("eval_count").asLong(0),
                Math.max(firstTokenMs, 0), millisSince(start));
    }

    private static long millisSince(long start) {
        return (System.nanoTime() - start) / 1_000_000;
    }
}
