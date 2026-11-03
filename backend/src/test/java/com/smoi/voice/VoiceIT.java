package com.smoi.voice;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import com.smoi.support.DocumentApiTest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * {@code POST /api/voice/transcribe} against a fake Whisper sidecar on a real port (FR-03.03).
 */
class VoiceIT extends DocumentApiTest {

    private static final HttpServer WHISPER;
    private static final AtomicInteger STATUS = new AtomicInteger(200);
    private static final AtomicReference<byte[]> RECEIVED = new AtomicReference<>();

    static {
        try {
            WHISPER = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        WHISPER.createContext("/transcribe", exchange -> {
            RECEIVED.set(exchange.getRequestBody().readAllBytes());
            byte[] body = (STATUS.get() == 200
                    ? "{\"model\":\"fake\",\"text\":\" remind me to feed the frog \",\"language\":\"en\",\"durationSeconds\":1.5}"
                    : "{\"detail\":\"nope\"}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(STATUS.get(), body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        WHISPER.start();
    }

    @DynamicPropertySource
    static void whisper(DynamicPropertyRegistry registry) {
        registry.add("smoi.stt.provider", () -> "whisper");
        registry.add("smoi.stt.base-url", () -> "http://127.0.0.1:" + WHISPER.getAddress().getPort());
    }

    private TestUser alice;

    @BeforeEach
    void user() {
        alice = newUser();
        STATUS.set(200);
    }

    @AfterEach
    void reset() {
        STATUS.set(200);
    }

    @Test
    void transcribesTheRecording() {
        byte[] audio = "RIFF fake wav".getBytes(StandardCharsets.US_ASCII);

        ResponseEntity<Map<String, Object>> res = transcribe(audio);

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody()).isEqualTo(Map.of("text", "remind me to feed the frog"));
        assertThat(RECEIVED.get()).isEqualTo(audio);
    }

    @Test
    void saysPlainlyWhenSpeechToTextIsDown() {
        STATUS.set(500);

        ResponseEntity<Map<String, Object>> res = transcribe(new byte[]{1, 2, 3});

        assertThat(res.getStatusCode().value()).isEqualTo(503);
        assertThat((String) res.getBody().get("detail")).contains("You can type instead");
    }

    @Test
    void undecodableAudioIsABadRequest() {
        STATUS.set(400);

        assertThat(transcribe(new byte[]{1}).getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void rejectsEmptyAndOversizedRecordings() {
        assertThat(transcribe(new byte[0]).getStatusCode().value()).isEqualTo(400);
        assertThat(transcribe(new byte[VoiceController.MAX_AUDIO_BYTES + 1]).getStatusCode().value()).isEqualTo(413);
    }

    @Test
    void requiresSignIn() {
        int status = http().post().uri("/api/voice/transcribe").contentType(MediaType.parseMediaType("audio/wav"))
                .body(new byte[]{1}).retrieve().toBodilessEntity().getStatusCode().value();
        assertThat(status).isEqualTo(401);
    }

    private ResponseEntity<Map<String, Object>> transcribe(byte[] audio) {
        return http().post().uri("/api/voice/transcribe").header("Authorization", "Bearer " + alice.token())
                .contentType(MediaType.parseMediaType("audio/wav")).body(audio).retrieve().toEntity(JSON);
    }
}
