package com.smoi.retrieval;

import java.util.Map;

import com.smoi.support.DocumentApiTest;
import com.smoi.support.TestFiles;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import static org.assertj.core.api.Assertions.assertThat;

class QueryEmbeddingCacheIT extends DocumentApiTest {

    @Autowired
    private MeterRegistry meters;

    private ResponseEntity<Map<String, Object>> search(TestUser user, String query) {
        return http().post().uri("/api/search")
                .header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("query", query, "mode", "hybrid"))
                .retrieve().toEntity(JSON);
    }

    private double count(String result) {
        return meters.get("smoi.query.embedding.cache").tag("result", result).counter().count();
    }

    private long rows(TestUser user) {
        return jdbc.sql("SELECT count(*) FROM query_embedding_cache WHERE user_id = :u AND deleted_at IS NULL")
                .param("u", user.id()).query(Long.class).single();
    }

    @Test
    void theSameQuestionAgainIsServedFromTheCacheWithTheSameResults() {
        TestUser user = newUser();
        String doc = uploadNew(user, "garden.txt", TestFiles.txt("The Larkspur garden opens at nine on Saturdays."));
        awaitStatus(user, doc, "indexed");
        double hitsBefore = count("hit");

        ResponseEntity<Map<String, Object>> first = search(user, "When does the Larkspur garden open?");
        ResponseEntity<Map<String, Object>> second = search(user, "  when does the larkspur   GARDEN open?  ");

        assertThat(count("hit")).isEqualTo(hitsBefore + 1);
        assertThat(second.getBody().get("results")).isEqualTo(first.getBody().get("results"));
        assertThat(rows(user)).isEqualTo(1);
    }

    @Test
    void aCachedQueryStillWorksWhileTheEmbeddingModelIsDown() {
        TestUser user = newUser();
        String doc = uploadNew(user, "garden.txt", TestFiles.txt("The Larkspur garden opens at nine on Saturdays."));
        awaitStatus(user, doc, "indexed");
        search(user, "Larkspur garden hours");

        embeddingFaults.failQueries(true);
        ResponseEntity<Map<String, Object>> response = search(user, "Larkspur garden hours");

        assertThat(response.getBody().get("fallback")).isNull(); // full hybrid, not keyword-only
    }

    @Test
    void theCacheIsPerUser() {
        TestUser alice = newUser();
        TestUser bob = newUser();
        search(alice, "What is the shared secret question?");
        double hitsBefore = count("hit");

        search(bob, "What is the shared secret question?");

        assertThat(count("hit")).isEqualTo(hitsBefore); // a miss for Bob, though Alice asked the same
        assertThat(rows(alice)).isEqualTo(1);
        assertThat(rows(bob)).isEqualTo(1);
    }

    @Test
    void onlyAHashOfTheQuestionIsStored() {
        TestUser user = newUser();
        search(user, "a very private question about my health");

        String stored = jdbc.sql("SELECT query_sha256 FROM query_embedding_cache WHERE user_id = :u AND deleted_at IS NULL")
                .param("u", user.id()).query(String.class).single();
        assertThat(stored).matches("[0-9a-f]{64}");
    }

    @Test
    void vectorsRoundTripThroughThePgvectorTextFormat() {
        float[] v = {0.25f, -1.5f, 3.0e-5f};
        assertThat(com.smoi.embedding.PgVector.parse(com.smoi.embedding.PgVector.literal(v))).containsExactly(v);
        assertThat(QueryEmbeddingCache.normalize("  Hello \n  World ")).isEqualTo("hello world");
    }
}
