package com.smoi.support;

import java.security.SecureRandom;
import java.util.Base64;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatusCode;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.RestClient;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Base class for integration tests: the real app on a random port, backed by a real
 * pgvector Postgres in Docker (the same image docker-compose uses). One container is
 * shared by every test class in the run.
 *
 * <p>Ingestion runs with short timings so failure scenarios finish in seconds, and with the
 * hashing embedder (wrapped by {@link FaultInjectingEmbeddingProvider}) so no model is needed.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(TestEmbeddingConfig.class)
public abstract class IntegrationTest {

    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
            DockerImageName.parse(System.getProperty("smoi.test.pgvector-image", "pgvector/pgvector:0.8.7-pg18-trixie"))
                    .asCompatibleSubstituteFor("postgres"));

    /** A fresh random key per test run, so no secret is ever committed for tests. */
    protected static final String TEST_JWT_SECRET;

    /** Shared fake reranker sidecar; tests switch its behaviour and reset it afterwards. */
    protected static final FakeRerankerServer RERANKER = new FakeRerankerServer();

    static {
        POSTGRES.start();
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        TEST_JWT_SECRET = Base64.getEncoder().encodeToString(key);
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        registry.add("smoi.jwt.secret", () -> TEST_JWT_SECRET);
        registry.add("smoi.embedding.provider", () -> "hashing");
        registry.add("smoi.rerank.enabled", () -> "true");
        registry.add("smoi.rerank.base-url", RERANKER::url);
        registry.add("smoi.rerank.timeout", () -> "PT2S");
        registry.add("smoi.ingestion.workers", () -> "4");
        registry.add("smoi.ingestion.poll-interval", () -> "PT0.05S");
        registry.add("smoi.ingestion.lease", () -> "PT5S");
        registry.add("smoi.ingestion.max-attempts", () -> "3");
        registry.add("smoi.ingestion.backoff-base", () -> "PT0.1S");
        registry.add("smoi.ingestion.backoff-max", () -> "PT1S");
        // Small chunks, so short test documents still produce several chunks.
        registry.add("smoi.chunking.max-tokens", () -> "100");
        registry.add("smoi.chunking.overlap-tokens", () -> "20");
        registry.add("spring.servlet.multipart.max-file-size", () -> "2MB");
        registry.add("spring.servlet.multipart.max-request-size", () -> "2MB");
    }

    @Value("${local.server.port}")
    private int port;

    /** HTTP client that never throws on 4xx/5xx, so tests can assert on status codes. */
    protected RestClient http() {
        return RestClient.builder()
                .baseUrl("http://localhost:" + port)
                .defaultStatusHandler(HttpStatusCode::isError, (req, res) -> { })
                .build();
    }
}
