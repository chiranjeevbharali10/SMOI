package com.smoi.support;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** Base for document API tests: test users, upload/replace/delete calls, and waiting for indexing. */
public abstract class DocumentApiTest extends IntegrationTest {

    protected static final ParameterizedTypeReference<Map<String, Object>> JSON = new ParameterizedTypeReference<>() { };
    protected static final ParameterizedTypeReference<List<Map<String, Object>>> JSON_LIST =
            new ParameterizedTypeReference<>() { };
    /** Throwaway password for test users (Testcontainers database only). */
    protected static final String PASSWORD = "correct-horse-battery";
    protected static final Duration INDEXING_TIMEOUT = Duration.ofSeconds(30);

    @Autowired
    protected FaultInjectingEmbeddingProvider embeddingFaults;

    @Autowired
    protected JdbcClient jdbc;

    @Autowired
    protected ScriptedLlmProvider llm;

    @Autowired
    protected com.smoi.resilience.ProviderCircuitBreakers breakers;

    @AfterEach
    void resetEmbeddingFaults() {
        embeddingFaults.reset();
        RERANKER.reset();
        llm.reset();
        breakers.reset();
    }

    public record TestUser(UUID id, String token) {
    }

    protected TestUser newUser() {
        String email = "user-" + UUID.randomUUID() + "@example.com";
        String password = PASSWORD;
        http().post().uri("/api/auth/register").contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("email", email, "password", password)).retrieve().toBodilessEntity();
        Map<String, Object> login = http().post().uri("/api/auth/login").contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("email", email, "password", password)).retrieve().body(JSON);
        String token = (String) login.get("accessToken");
        Map<String, Object> me = http().get().uri("/api/me").header("Authorization", "Bearer " + token)
                .retrieve().body(JSON);
        return new TestUser(UUID.fromString((String) me.get("id")), token);
    }

    protected ResponseEntity<Map<String, Object>> upload(TestUser user, String filename, byte[] content) {
        return http().post().uri("/api/documents")
                .header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .body(multipart(filename, content))
                .retrieve().toEntity(JSON);
    }

    protected ResponseEntity<Map<String, Object>> replace(TestUser user, Object documentId, String filename, byte[] content) {
        return http().put().uri("/api/documents/{id}/file", documentId)
                .header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .body(multipart(filename, content))
                .retrieve().toEntity(JSON);
    }

    protected ResponseEntity<Map<String, Object>> getDocument(TestUser user, Object documentId) {
        return http().get().uri("/api/documents/{id}", documentId)
                .header("Authorization", "Bearer " + user.token())
                .retrieve().toEntity(JSON);
    }

    protected ResponseEntity<List<Map<String, Object>>> listDocuments(TestUser user) {
        return http().get().uri("/api/documents")
                .header("Authorization", "Bearer " + user.token())
                .retrieve().toEntity(JSON_LIST);
    }

    protected ResponseEntity<List<Map<String, Object>>> getChunks(TestUser user, Object documentId) {
        return http().get().uri("/api/documents/{id}/chunks", documentId)
                .header("Authorization", "Bearer " + user.token())
                .retrieve().toEntity(JSON_LIST);
    }

    /** Status code of the chunks endpoint, for cases where the body is an error, not a list. */
    protected int chunksStatus(TestUser user, Object documentId) {
        return http().get().uri("/api/documents/{id}/chunks", documentId)
                .header("Authorization", "Bearer " + user.token())
                .retrieve().toBodilessEntity().getStatusCode().value();
    }

    protected int delete(TestUser user, Object documentId) {
        return http().delete().uri("/api/documents/{id}", documentId)
                .header("Authorization", "Bearer " + user.token())
                .retrieve().toBodilessEntity().getStatusCode().value();
    }

    /** Uploads a file and returns its document id, asserting the upload was accepted. */
    protected String uploadNew(TestUser user, String filename, byte[] content) {
        ResponseEntity<Map<String, Object>> res = upload(user, filename, content);
        assertThat(res.getStatusCode().value()).as("upload status, body %s", res.getBody()).isEqualTo(202);
        return (String) res.getBody().get("id");
    }

    /** Polls the status API until the document reaches {@code status}, then returns it. */
    protected Map<String, Object> awaitStatus(TestUser user, Object documentId, String status) {
        return await().atMost(INDEXING_TIMEOUT).pollInterval(Duration.ofMillis(50))
                .until(() -> getDocument(user, documentId).getBody(), body -> status.equals(body.get("status")));
    }

    public record JobRow(String status, int attempts, String lastError) {
    }

    /** The ingestion jobs of one document, oldest first. Scoped by user_id like every other query. */
    protected List<JobRow> jobs(TestUser user, Object documentId) {
        return jdbc.sql("""
                        SELECT status, attempts, last_error FROM ingestion_jobs
                         WHERE user_id = :userId AND document_id = :documentId AND deleted_at IS NULL
                         ORDER BY created_at, id
                        """)
                .param("userId", user.id())
                .param("documentId", UUID.fromString(documentId.toString()))
                .query(JobRow.class)
                .list();
    }

    /** Counts chunk rows directly in the database (including any the API might hide). */
    protected long chunkRows(TestUser user, Object documentId) {
        return jdbc.sql("SELECT count(*) FROM document_chunks WHERE user_id = :userId AND document_id = :documentId")
                .param("userId", user.id())
                .param("documentId", UUID.fromString(documentId.toString()))
                .query(Long.class)
                .single();
    }

    protected static MultiValueMap<String, Object> multipart(String filename, byte[] content) {
        MultiValueMap<String, Object> parts = new LinkedMultiValueMap<>();
        parts.add("file", new ByteArrayResource(content) {
            @Override
            public String getFilename() {
                return filename;
            }
        });
        return parts;
    }
}
