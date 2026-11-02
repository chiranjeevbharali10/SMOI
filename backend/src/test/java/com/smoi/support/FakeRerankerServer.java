package com.smoi.support;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.sun.net.httpserver.HttpServer;
import tools.jackson.databind.json.JsonMapper;

/**
 * Stands in for the Python reranker sidecar in integration tests. By default it scores each
 * passage by how often it contains the "boost" word, so a test can predict the reranked order.
 * It can also be switched to fail, to test the fallback.
 */
public final class FakeRerankerServer {

    public enum Mode { UP, DOWN }

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private final HttpServer server;
    private final AtomicReference<Mode> mode = new AtomicReference<>(Mode.UP);
    private final AtomicReference<String> boostWord = new AtomicReference<>("");

    public FakeRerankerServer() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        server.createContext("/rerank", exchange -> {
            byte[] body;
            int status;
            if (mode.get() == Mode.DOWN) {
                status = 503;
                body = "{\"detail\":\"down\"}".getBytes(StandardCharsets.UTF_8);
            } else {
                Map<?, ?> request = JSON.readValue(exchange.getRequestBody(), Map.class);
                List<Double> scores = new ArrayList<>();
                Pattern word = Pattern.compile(Pattern.quote(boostWord.get()), Pattern.CASE_INSENSITIVE);
                for (Object passage : (List<?>) request.get("passages")) {
                    Matcher m = word.matcher(passage.toString());
                    int count = 0;
                    while (!boostWord.get().isEmpty() && m.find()) {
                        count++;
                    }
                    scores.add((double) count);
                }
                status = 200;
                body = JSON.writeValueAsBytes(Map.of("model", "fake-cross-encoder", "scores", scores));
            }
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
    }

    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public void boost(String word) {
        boostWord.set(word);
    }

    public void setMode(Mode newMode) {
        mode.set(newMode);
    }

    public void reset() {
        mode.set(Mode.UP);
        boostWord.set("");
    }
}
