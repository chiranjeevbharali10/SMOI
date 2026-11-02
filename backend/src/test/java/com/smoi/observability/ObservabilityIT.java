package com.smoi.observability;

import java.util.Map;

import com.smoi.support.DocumentApiTest;
import com.smoi.support.TestFiles;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.test.web.server.LocalManagementPort;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.RestClient;

import static org.assertj.core.api.Assertions.assertThat;

/** NFR-07.04 (request ids, structured logs without content or secrets) and the metrics endpoint. */
@ExtendWith(OutputCaptureExtension.class)
class ObservabilityIT extends DocumentApiTest {

    @LocalManagementPort
    private int managementPort;

    private String prometheus() {
        return RestClient.create("http://localhost:" + managementPort).get().uri("/actuator/prometheus")
                .retrieve().body(String.class);
    }

    @Test
    void everyResponseCarriesARequestId() {
        ResponseEntity<String> response = http().get().uri("/api/me").retrieve().toEntity(String.class);

        assertThat(response.getStatusCode().value()).isEqualTo(401); // even rejected requests
        assertThat(response.getHeaders().getFirst("X-Request-Id")).matches("[0-9a-f-]{36}");
    }

    @Test
    void aSafeCallerRequestIdIsKeptAndAnUnsafeOneReplaced() {
        String kept = http().get().uri("/api/me").header("X-Request-Id", "desktop-42.a_b")
                .retrieve().toEntity(String.class).getHeaders().getFirst("X-Request-Id");
        String replaced = http().get().uri("/api/me").header("X-Request-Id", "spaces and {\"json\":1}")
                .retrieve().toEntity(String.class).getHeaders().getFirst("X-Request-Id");

        assertThat(kept).isEqualTo("desktop-42.a_b");
        assertThat(replaced).matches("[0-9a-f-]{36}");
    }

    @Test
    void logsAreJsonWithTheRequestIdAndNeverContainContentPasswordsOrTokens(CapturedOutput output) {
        String secretText = "PLUMTREE-SENTINEL-7781 is a private note";
        TestUser user = newUser(); // registers with a password; the token is in user.token()
        ResponseEntity<Map<String, Object>> uploaded = http().post().uri("/api/documents")
                .header("Authorization", "Bearer " + user.token())
                .header("X-Request-Id", "upload-req-1")
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .body(multipart("note.txt", TestFiles.txt(secretText + ".\n\nMore private text.")))
                .retrieve().toEntity(JSON);
        awaitStatus(user, uploaded.getBody().get("id"), "indexed");
        http().post().uri("/api/query")
                .header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("question", "What is PLUMTREE-SENTINEL-7781?"))
                .retrieve().toEntity(JSON);

        String logs = output.getAll();
        assertThat(logs).doesNotContain("PLUMTREE-SENTINEL-7781");
        assertThat(logs).doesNotContain(user.token());
        assertThat(logs).doesNotContain(PASSWORD);
        // The ingestion job's log lines carry the upload's request id.
        assertThat(logs).containsPattern("\"message\":\"Indexed document[^\\n]*\"requestId\":\"upload-req-1\"");
    }

    @Test
    void prometheusExposesSmoiMetrics() {
        TestUser user = newUser();
        String doc = uploadNew(user, "garden.txt", TestFiles.txt("The Larkspur garden opens at nine."));
        awaitStatus(user, doc, "indexed");
        http().post().uri("/api/query")
                .header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("question", "When does the garden open?"))
                .retrieve().toEntity(JSON);

        String metrics = prometheus();

        assertThat(metrics)
                .contains("smoi_retrieval_stage_seconds_bucket")
                .contains("smoi_llm_generation_seconds")
                .contains("smoi_llm_tokens_total")
                .contains("smoi_llm_cost_usd")
                .contains("smoi_ingestion_job_seconds_count{outcome=\"succeeded\"")
                .contains("smoi_ingestion_queue_jobs{state=\"ready\"}")
                .contains("smoi_answers_total")
                .contains("resilience4j_circuitbreaker_state");
    }

    @Test
    void metricsAreNotServedOnTheApiPort() {
        int status = http().get().uri("/actuator/prometheus").retrieve().toBodilessEntity().getStatusCode().value();

        assertThat(status).isIn(401, 404);
    }
}
