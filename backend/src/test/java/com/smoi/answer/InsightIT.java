package com.smoi.answer;

import java.util.Map;

import com.smoi.support.DocumentApiTest;
import com.smoi.support.TestFiles;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import static org.assertj.core.api.Assertions.assertThat;

/** Document summary and comparison (FR-06.09). */
class InsightIT extends DocumentApiTest {

    private TestUser user;
    private String gardenDoc;
    private String parkDoc;

    @BeforeEach
    void seed() {
        user = newUser();
        gardenDoc = uploadNew(user, "garden.txt", TestFiles.txt("The garden opens at nine.\n\nPlots are assigned in March."));
        parkDoc = uploadNew(user, "park.txt", TestFiles.txt("The park opens at seven.\n\nDogs must be on a lead."));
        awaitStatus(user, gardenDoc, "indexed");
        awaitStatus(user, parkDoc, "indexed");
    }

    private ResponseEntity<Map<String, Object>> summary(TestUser who, String id) {
        return http().post().uri("/api/documents/{id}/summary", id)
                .header("Authorization", "Bearer " + who.token()).retrieve().toEntity(JSON);
    }

    private ResponseEntity<Map<String, Object>> compare(TestUser who, String a, String b) {
        return http().post().uri("/api/documents/compare")
                .header("Authorization", "Bearer " + who.token())
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("first", a, "second", b))
                .retrieve().toEntity(JSON);
    }

    @Test
    void summaryCitesTheDocumentsChunks() {
        llm.replyWith("The garden opens at nine and assigns plots in March [S1].");

        ResponseEntity<Map<String, Object>> res = summary(user, gardenDoc);

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody()).containsEntry("outcome", "answered").containsEntry("passes", 1);
        assertThat(llm.requests().getLast().user()).contains("garden.txt").doesNotContain("park.txt");
    }

    @Test
    void aLongDocumentIsSummarisedFromNotesInSeveralPasses() {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < 8; i++) {
            text.append(TestFiles.paragraph("section " + i, 60)).append("\n\n");
        }
        String longDoc = uploadNew(user, "long.txt", TestFiles.txt(text.toString()));
        awaitStatus(user, longDoc, "indexed");
        llm.setMaxPromptTokens(500);
        llm.replyWith("Notes about this part [S1].");

        ResponseEntity<Map<String, Object>> res = summary(user, longDoc);

        assertThat(res.getBody()).containsEntry("outcome", "answered");
        assertThat((Integer) res.getBody().get("passes")).isGreaterThan(2);
        assertThat(llm.requests().getLast().user()).contains("<notes document=\"long.txt\">");
    }

    @Test
    void compareGivesTheModelBothDocuments() {
        // Each short document is one chunk: S1 is the garden, S2 the park.
        llm.replyWith("The garden opens at nine [S1] while the park opens at seven [S2].");

        ResponseEntity<Map<String, Object>> res = compare(user, gardenDoc, parkDoc);

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(llm.requests().getLast().user()).contains("garden.txt").contains("park.txt");
    }

    @Test
    void fabricatedCitationsInASummaryAreRejected() {
        llm.replyWith("A summary [S42].");

        ResponseEntity<Map<String, Object>> res = summary(user, gardenDoc);

        assertThat(res.getStatusCode().value()).isEqualTo(502);
        assertThat(res.getBody()).containsEntry("outcome", "citation_rejected");
    }

    @Test
    void anotherUserGets404() {
        TestUser other = newUser();

        assertThat(summary(other, gardenDoc).getStatusCode().value()).isEqualTo(404);
        assertThat(compare(other, gardenDoc, parkDoc).getStatusCode().value()).isEqualTo(404);
        assertThat(llm.requests()).isEmpty();
    }

    @Test
    void aHostedProviderMayOnlySummariseAllowedDocuments() {
        llm.setHosted(true);

        ResponseEntity<Map<String, Object>> res = summary(user, gardenDoc);

        assertThat(res.getStatusCode().value()).isEqualTo(403);
        assertThat(llm.requests()).isEmpty();
    }

    @Test
    void comparingADocumentWithItselfIsABadRequest() {
        assertThat(compare(user, gardenDoc, gardenDoc).getStatusCode().value()).isEqualTo(400);
    }
}
