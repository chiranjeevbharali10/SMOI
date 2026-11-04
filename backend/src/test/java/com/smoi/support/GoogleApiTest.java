package com.smoi.support;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import com.smoi.llm.LlmRequest;
import com.smoi.llm.LlmResult;
import org.junit.jupiter.api.AfterEach;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Base for Phase 8 tests: the real app and Postgres, with Google replaced by {@link FakeGoogleServer}.
 * Credentials are made up for each run; nothing real is used.
 */
public abstract class GoogleApiTest extends DocumentApiTest {

    protected static final FakeGoogleServer GOOGLE = new FakeGoogleServer();
    private static final String TOKEN_KEY;

    static {
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        TOKEN_KEY = Base64.getEncoder().encodeToString(key);
    }

    @DynamicPropertySource
    static void google(DynamicPropertyRegistry r) {
        r.add("smoi.google.client-id", () -> "test-client-id");
        r.add("smoi.google.client-secret", () -> "test-client-secret-not-real");
        r.add("smoi.google.token-key", () -> TOKEN_KEY);
        r.add("smoi.google.redirect-uri", () -> "http://localhost/api/google/callback");
        r.add("smoi.google.auth-url", () -> GOOGLE.url() + "/auth");
        r.add("smoi.google.token-url", () -> GOOGLE.url() + "/token");
        r.add("smoi.google.revoke-url", () -> GOOGLE.url() + "/revoke");
        r.add("smoi.google.gmail-url", GOOGLE::url);
        r.add("smoi.google.calendar-url", () -> GOOGLE.url() + "/calendar/v3");
        r.add("smoi.google.timeout", () -> "PT3S");
        r.add("smoi.google.max-retries", () -> "3");
        r.add("smoi.google.backoff-base", () -> "PT0.01S");
        r.add("smoi.resilience.google.wait-in-open", () -> "PT1S");
    }

    @AfterEach
    void resetGoogle() {
        GOOGLE.reset();
    }

    /** The scripted model answers email classification with {@code classification}, and commands as before. */
    protected void classifyAs(Function<LlmRequest, String> classification) {
        llm.reply(r -> ScriptedLlmProvider.complete(r.system().contains("You sort one email")
                ? classification.apply(r) : "{\"intent\":\"unknown\"}"));
    }

    protected static LlmResult complete(String text) {
        return ScriptedLlmProvider.complete(text);
    }

    /** Runs the whole OAuth flow for the user against the fake Google. */
    protected void connect(TestUser user) {
        Map<String, Object> res = post(user, "/api/google/connect", null).getBody();
        String url = (String) res.get("authorizationUrl");
        String state = query(url, "state");
        assertThat(query(url, "code_challenge_method")).isEqualTo("S256");
        ResponseEntity<String> cb = callback(state, FakeGoogleServer.GOOD_CODE);
        assertThat(cb.getStatusCode().value()).as(cb.getBody()).isEqualTo(200);
    }

    protected ResponseEntity<String> callback(String state, String code) {
        return http().get().uri(u -> u.path("/api/google/callback").queryParam("state", state).queryParam("code", code).build())
                .retrieve().toEntity(String.class);
    }

    protected static String query(String url, String name) {
        for (String p : URI.create(url).getRawQuery().split("&")) {
            String[] kv = p.split("=", 2);
            if (kv[0].equals(name)) {
                return URLDecoder.decode(kv[1], StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    protected ResponseEntity<Map<String, Object>> post(TestUser user, String path, Object body) {
        var req = http().post().uri(path).header("Authorization", "Bearer " + user.token()).contentType(MediaType.APPLICATION_JSON);
        return (body == null ? req : req.body(body)).retrieve().toEntity(JSON);
    }

    protected ResponseEntity<List<Map<String, Object>>> postList(TestUser user, String path) {
        return http().post().uri(path).header("Authorization", "Bearer " + user.token()).retrieve().toEntity(JSON_LIST);
    }

    protected ResponseEntity<Map<String, Object>> get(TestUser user, String path) {
        return http().get().uri(path).header("Authorization", "Bearer " + user.token()).retrieve().toEntity(JSON);
    }

    protected ResponseEntity<List<Map<String, Object>>> getList(TestUser user, String path) {
        return http().get().uri(path).header("Authorization", "Bearer " + user.token()).retrieve().toEntity(JSON_LIST);
    }

    /** Requests SMOI sent to Google that would send, delete, trash or relabel mail. Must stay empty. */
    protected static List<FakeGoogleServer.Request> forbiddenGmailCalls() {
        return GOOGLE.requests().stream()
                .filter(r -> r.path().startsWith("/gmail/"))
                .filter(r -> r.path().contains("/send") || r.path().contains("/trash") || r.path().contains("modify")
                        || r.path().contains("batch") || r.method().equals("DELETE") || r.path().contains("/import")
                        || (r.method().equals("POST") && r.path().endsWith("/messages")))
                .toList();
    }
}
