package com.smoi.support;

import java.security.SecureRandom;
import java.util.Base64;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
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
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
public abstract class IntegrationTest {

    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
            DockerImageName.parse(System.getProperty("smoi.test.pgvector-image", "pgvector/pgvector:0.8.7-pg18-trixie"))
                    .asCompatibleSubstituteFor("postgres"));

    /** A fresh random key per test run, so no secret is ever committed for tests. */
    protected static final String TEST_JWT_SECRET;

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
