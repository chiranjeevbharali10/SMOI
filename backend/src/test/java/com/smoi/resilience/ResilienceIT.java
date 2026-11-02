package com.smoi.resilience;

import java.util.List;
import java.util.Map;

import com.smoi.llm.LlmUnavailableException;
import com.smoi.support.DocumentApiTest;
import com.smoi.support.ScriptedLlmProvider;
import com.smoi.support.TestFiles;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** NFR-02.07: when a model provider is down, requests degrade with a clear notice instead of failing. */
class ResilienceIT extends DocumentApiTest {

    private TestUser user;

    @BeforeEach
    void seed() {
        user = newUser();
        String doc = uploadNew(user, "garden.txt", TestFiles.txt("""
                The Larkspur garden opens at nine on Saturdays.

                Plots are assigned every March by lottery."""));
        awaitStatus(user, doc, "indexed");
    }

    private ResponseEntity<Map<String, Object>> post(String path, Map<String, Object> body) {
        return http().post().uri(path)
                .header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve().toEntity(JSON);
    }

    private void llmIsDown() {
        llm.reply(request -> {
            throw new LlmUnavailableException("Injected: connection refused");
        });
    }

    @Test
    @SuppressWarnings("unchecked")
    void whenTheLlmIsDownTheAnswerIsTheRetrievedPassagesWithANotice() {
        llmIsDown();

        ResponseEntity<Map<String, Object>> response = post("/api/query", Map.of("question", "When does the Larkspur garden open?"));

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        Map<String, Object> body = response.getBody();
        assertThat(body.get("outcome")).isEqualTo("llm_unavailable");
        assertThat(body.get("answer")).isNull();
        assertThat((String) body.get("message")).contains("Answer generation is unavailable");
        List<Map<String, Object>> passages = (List<Map<String, Object>>) body.get("passages");
        assertThat(passages).isNotEmpty();
        assertThat((String) passages.getFirst().get("content")).contains("Larkspur garden opens at nine");
        assertThat(passages.getFirst().get("filename")).isEqualTo("garden.txt");
    }

    @Test
    void repeatedLlmFailuresOpenTheCircuitSoTheLlmIsNoLongerCalled() {
        llmIsDown();
        // minimum-calls is 4 and the threshold 50%: four failures open the breaker.
        for (int i = 0; i < 4; i++) {
            post("/api/query", Map.of("question", "When does the garden open?"));
        }
        assertThat(breakers.llmState()).isEqualTo(CircuitBreaker.State.OPEN);
        int callsSoFar = llm.requests().size();

        ResponseEntity<Map<String, Object>> response = post("/api/query", Map.of("question", "When does the garden open?"));

        assertThat(response.getBody().get("outcome")).isEqualTo("llm_unavailable");
        assertThat(llm.requests()).hasSize(callsSoFar); // rejected by the breaker, not sent
    }

    @Test
    void theCircuitClosesAgainOnceTheLlmRecovers() {
        llmIsDown();
        for (int i = 0; i < 4; i++) {
            post("/api/query", Map.of("question", "When does the garden open?"));
        }
        assertThat(breakers.llmState()).isEqualTo(CircuitBreaker.State.OPEN);

        llm.reply(ScriptedLlmProvider.CITE_FIRST_SOURCE);
        // wait-in-open is 1 s in tests; then trial calls are let through and close the breaker.
        await().atMost(java.time.Duration.ofSeconds(10)).untilAsserted(() -> {
            ResponseEntity<Map<String, Object>> response = post("/api/query", Map.of("question", "When does the garden open?"));
            assertThat(response.getBody().get("outcome")).isEqualTo("answered");
        });
        post("/api/query", Map.of("question", "When does the garden open?"));
        assertThat(breakers.llmState()).isEqualTo(CircuitBreaker.State.CLOSED);
    }

    @Test
    void whenTheEmbeddingModelIsDownSearchFallsBackToKeywordAndSaysSo() {
        embeddingFaults.failQueries(true);

        ResponseEntity<Map<String, Object>> response = post("/api/search",
                Map.of("query", "Larkspur garden opens", "mode", "hybrid"));

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat((String) response.getBody().get("fallback")).contains("only keyword search");
        assertThat((List<?>) response.getBody().get("results")).isNotEmpty();
    }

    @Test
    void vectorModeAlsoFallsBackRatherThanFailing() {
        embeddingFaults.failQueries(true);

        ResponseEntity<Map<String, Object>> response = post("/api/search",
                Map.of("query", "Larkspur garden opens", "mode", "vector"));

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody().get("fallback")).isNotNull();
        assertThat((List<?>) response.getBody().get("results")).isNotEmpty();
    }

    @Test
    void answersStillWorkWhenOnlyTheEmbeddingModelIsDown() {
        embeddingFaults.failQueries(true);
        llm.reply(ScriptedLlmProvider.CITE_FIRST_SOURCE);

        ResponseEntity<Map<String, Object>> response = post("/api/query",
                Map.of("question", "When does the Larkspur garden open?"));

        assertThat(response.getBody().get("outcome")).isEqualTo("answered");
    }
}
