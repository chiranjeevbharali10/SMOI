package com.smoi.retrieval;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.smoi.support.DocumentApiTest;
import com.smoi.support.FakeRerankerServer;
import com.smoi.support.TestFiles;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import static org.assertj.core.api.Assertions.assertThat;

/** Retrieval on a small seeded corpus (FR-06.05, NFR-03.11, NFR-03.13). */
class SearchIT extends DocumentApiTest {

    @Autowired
    private RetrievalService retrieval;

    private TestUser user;
    private String gardenDoc;
    private String frogDoc;
    private String taxDoc;

    @BeforeEach
    void seedCorpus() {
        user = newUser();
        gardenDoc = uploadNew(user, "garden.txt", TestFiles.txt("""
                The Larkspur community garden opens at seven on weekdays and nine on weekends.

                Plots are assigned every March by lottery. The quartzberry beds are reserved for the school.

                Members pay an annual fee and may volunteer in the garden to have the fee refunded."""));
        frogDoc = uploadNew(user, "frogs.txt", TestFiles.txt("""
                Frogs are amphibians. Tadpoles live in ponds and breathe through gills.

                Adult frogs eat insects and can live in the garden pond during summer."""));
        taxDoc = uploadNew(user, "tax.txt", TestFiles.txt("""
                Quarterly estimated tax payments are due in April, June, September and January.

                Late payments incur penalties and interest."""));
        for (String id : List.of(gardenDoc, frogDoc, taxDoc)) {
            awaitStatus(user, id, "indexed");
        }
    }

    private ResponseEntity<Map<String, Object>> search(TestUser who, String query, String mode, Integer topK) {
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("query", query);
        if (mode != null) {
            body.put("mode", mode);
        }
        if (topK != null) {
            body.put("topK", topK);
        }
        return http().post().uri("/api/search")
                .header("Authorization", "Bearer " + who.token())
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve().toEntity(JSON);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> results(ResponseEntity<Map<String, Object>> res) {
        return (List<Map<String, Object>>) res.getBody().get("results");
    }

    @ParameterizedTest
    @ValueSource(strings = {"keyword", "vector", "hybrid", "hybrid_rerank"})
    void everyModeReturnsRankedResults(String mode) {
        ResponseEntity<Map<String, Object>> res = search(user, "when does the garden open on weekends", mode, 5);

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody()).containsEntry("mode", mode).containsKey("timings");
        List<Map<String, Object>> hits = results(res);
        assertThat(hits).isNotEmpty().hasSizeLessThanOrEqualTo(5);
        assertThat(hits).extracting(h -> h.get("rank")).containsExactlyElementsOf(
                java.util.stream.IntStream.rangeClosed(1, hits.size()).boxed().toList());
        assertThat(hits).extracting(h -> ((Number) h.get("score")).doubleValue())
                .isSortedAccordingTo(java.util.Comparator.reverseOrder());
        assertThat(hits.getFirst()).containsEntry("documentId", gardenDoc).containsEntry("filename", "garden.txt");
    }

    @Test
    void keywordSearchFindsARareExactTerm() {
        List<Map<String, Object>> hits = results(search(user, "quartzberry", "keyword", 5));

        assertThat(hits).singleElement().satisfies(h -> {
            assertThat(h).containsEntry("documentId", gardenDoc);
            assertThat((String) h.get("content")).contains("quartzberry");
            assertThat(h).containsEntry("keywordRank", 1);
        });
    }

    @Test
    void keywordSearchMatchesAnyWordNotAllWords() {
        // "frogs" appears in frogs.txt, "penalties" in tax.txt; no single chunk has both.
        List<Map<String, Object>> hits = results(search(user, "frogs penalties", "keyword", 10));

        assertThat(hits).extracting(h -> h.get("documentId")).contains(frogDoc, taxDoc);
    }

    @Test
    void hybridRecordsWhichListsEachResultCameFrom() {
        List<Map<String, Object>> hits = results(search(user, "quartzberry", "hybrid", 10));

        Map<String, Object> top = hits.getFirst();
        assertThat(top).containsEntry("documentId", gardenDoc).containsEntry("keywordRank", 1);
        assertThat(top.get("vectorRank")).isNotNull();
        // Vector search returns every chunk of the user, so some results have no keyword rank.
        assertThat(hits).anySatisfy(h -> assertThat(h.get("keywordRank")).isNull());
    }

    @Test
    void rerankingReordersTheCandidates() {
        RERANKER.boost("tax");

        ResponseEntity<Map<String, Object>> res = search(user, "garden opening hours", "hybrid_rerank", 5);

        assertThat(res.getBody()).containsEntry("rerank", "applied").containsEntry("rerankModel", "fake-cross-encoder");
        // Hybrid would rank the garden first; the reranker scores only the tax chunk above zero.
        assertThat(results(res).getFirst()).containsEntry("documentId", taxDoc);
    }

    @Test
    void whenTheRerankerIsDownResultsComeBackInHybridOrderAndSaySo() {
        List<Map<String, Object>> hybrid = results(search(user, "garden opening hours", "hybrid", 5));
        RERANKER.setMode(FakeRerankerServer.Mode.DOWN);

        ResponseEntity<Map<String, Object>> res = search(user, "garden opening hours", "hybrid_rerank", 5);

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody()).containsEntry("rerank", "skipped");
        assertThat((String) res.getBody().get("rerankNote")).contains("Reranker request failed");
        assertThat(results(res)).extracting(h -> h.get("chunkId"))
                .containsExactlyElementsOf(hybrid.stream().map(h -> h.get("chunkId")).toList());
    }

    @ParameterizedTest
    @ValueSource(strings = {"keyword", "vector", "hybrid", "hybrid_rerank"})
    void anotherUserNeverSeesTheseChunks(String mode) {
        TestUser other = newUser();
        // The other user has a document of their own that shares one query word ("garden"), so
        // every mode has something legitimate to return, and only that.
        String own = uploadNew(other, "own.txt", TestFiles.txt("My own garden note " + UUID.randomUUID()));
        awaitStatus(other, own, "indexed");

        List<Map<String, Object>> hits = results(search(other, "quartzberry garden frogs tax", mode, 50));

        assertThat(hits).isNotEmpty().allSatisfy(h -> assertThat(h).containsEntry("documentId", own));
    }

    @Test
    void deletedDocumentsAreNotRetrieved() {
        delete(user, gardenDoc);

        for (String mode : List.of("keyword", "vector", "hybrid")) {
            assertThat(results(search(user, "quartzberry garden", mode, 50)))
                    .as(mode).noneSatisfy(h -> assertThat(h).containsEntry("documentId", gardenDoc));
        }
    }

    @Test
    void hostedOnlyRetrievalSkipsDocumentsNotAllowedForHostedLlms() {
        RetrievalResult before = retrieval.retrieve(user.id(), "garden frogs tax", RetrievalMode.HYBRID, 50, true);
        assertThat(before.chunks()).isEmpty(); // nothing is allowed by default

        ResponseEntity<Map<String, Object>> patched = http().patch().uri("/api/documents/{id}", frogDoc)
                .header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("hostedLlmAllowed", true))
                .retrieve().toEntity(JSON);
        assertThat(patched.getBody()).containsEntry("hostedLlmAllowed", true);

        RetrievalResult after = retrieval.retrieve(user.id(), "garden frogs tax", RetrievalMode.HYBRID, 50, true);
        assertThat(after.chunks()).isNotEmpty()
                .allSatisfy(c -> assertThat(c.documentId().toString()).isEqualTo(frogDoc));
    }

    @Test
    void anotherUserCannotChangeTheHostedSetting() {
        TestUser other = newUser();

        int status = http().patch().uri("/api/documents/{id}", frogDoc)
                .header("Authorization", "Bearer " + other.token())
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("hostedLlmAllowed", true))
                .retrieve().toBodilessEntity().getStatusCode().value();

        assertThat(status).isEqualTo(404);
        assertThat(getDocument(user, frogDoc).getBody()).containsEntry("hostedLlmAllowed", false);
    }

    @Test
    void invalidRequestsAreRejected() {
        assertThat(search(user, "", "hybrid", 5).getStatusCode().value()).isEqualTo(400);
        assertThat(search(user, "garden", "hybrid", 0).getStatusCode().value()).isEqualTo(400);
        assertThat(search(user, "garden", "fuzzy", 5).getStatusCode().value()).isEqualTo(400);
    }
}
