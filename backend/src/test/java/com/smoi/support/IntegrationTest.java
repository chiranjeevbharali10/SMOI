package com.smoi.support;

import java.security.SecureRandom;
import java.util.Base64;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatusCode;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
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
// Generous rate limits so ordinary tests never hit them. A subclass's own @TestPropertySource
// overrides these (RateLimitIT sets tight ones); @DynamicPropertySource values could not be overridden.
@TestPropertySource(properties = {
        "smoi.rate-limit.query.capacity=10000",
        "smoi.rate-limit.search.capacity=10000",
        "smoi.rate-limit.upload.capacity=10000"
})
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
        // Breakers reopen quickly, so a test that opens one doesn't slow the next.
        registry.add("smoi.resilience.llm.wait-in-open", () -> "PT1S");
        registry.add("smoi.resilience.embedding.wait-in-open", () -> "PT1S");
        registry.add("smoi.resilience.reranker.wait-in-open", () -> "PT1S");
        // Metrics on a random port of their own, as in production.
        registry.add("management.server.port", () -> "0");
        registry.add("logging.structured.format.console", () -> "logstash");
    }

    /**
     * Creates an empty database in the shared container and returns its JDBC URL. Spring keeps
     * every test context alive, and each runs ingestion workers; a context whose workers must not
     * share jobs with the others (different ingestion settings) points its datasource here.
     */
    protected static String createDatabase(String name) {
        if (!name.matches("[a-z_]+")) {
            throw new IllegalArgumentException("database names here are lower-case letters and underscores");
        }
        try (java.sql.Connection c = java.sql.DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()); java.sql.Statement st = c.createStatement()) {
            st.execute("DROP DATABASE IF EXISTS " + name);
            st.execute("CREATE DATABASE " + name);
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
        // jdbc:postgresql://host:port/test?loggerLevel=OFF -> jdbc:postgresql://host:port/<name>?loggerLevel=OFF
        return POSTGRES.getJdbcUrl().replaceFirst("/[^/?]+(\\?|$)", "/" + name + "$1");
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
