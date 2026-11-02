package com.smoi.document;

import java.util.Map;
import java.util.UUID;

import com.smoi.support.DocumentApiTest;
import com.smoi.support.TestFiles;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import static com.smoi.support.TestFiles.paragraph;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * User B can't read, change or delete user A's documents through any endpoint (NFR-03.04,
 * NFR-03.12). B gets the same 404 as for a document that doesn't exist.
 */
class DocumentIsolationIT extends DocumentApiTest {

    private TestUser alice;
    private TestUser bob;
    private String aliceDoc;
    private byte[] aliceFile;

    @BeforeEach
    void aliceHasAnIndexedDocument() {
        alice = newUser();
        bob = newUser();
        aliceFile = TestFiles.txt(paragraph("alice private " + UUID.randomUUID(), 80));
        aliceDoc = uploadNew(alice, "alice.txt", aliceFile);
        awaitStatus(alice, aliceDoc, "indexed");
    }

    @Test
    void bobCannotReadAlicesDocument() {
        ResponseEntity<Map<String, Object>> asBob = getDocument(bob, aliceDoc);
        ResponseEntity<Map<String, Object>> missing = getDocument(bob, UUID.randomUUID());

        assertThat(asBob.getStatusCode().value()).isEqualTo(404);
        assertThat(asBob.getBody()).isEqualTo(withoutInstance(missing.getBody(), asBob.getBody()));
    }

    @Test
    void bobCannotReadAlicesChunks() {
        assertThat(chunksStatus(bob, aliceDoc)).isEqualTo(404);
    }

    @Test
    void bobDoesNotSeeAlicesDocumentInHisList() {
        assertThat(listDocuments(bob).getBody()).isEmpty();
    }

    @Test
    void bobCannotDeleteAlicesDocument() {
        assertThat(delete(bob, aliceDoc)).isEqualTo(404);

        assertThat(getDocument(alice, aliceDoc).getBody()).containsEntry("status", "indexed");
        assertThat(chunkRows(alice, aliceDoc)).isPositive();
    }

    @Test
    void bobCannotReplaceAlicesFile() {
        ResponseEntity<Map<String, Object>> res = replace(bob, aliceDoc, "evil.txt",
                TestFiles.txt(paragraph("overwrite " + UUID.randomUUID(), 20)));

        assertThat(res.getStatusCode().value()).isEqualTo(404);
        assertThat(getDocument(alice, aliceDoc).getBody()).containsEntry("version", 1).containsEntry("filename", "alice.txt");
    }

    @Test
    void uploadingTheSameFileAsAnotherUserCreatesASeparateDocument() {
        // Duplicate detection is per user: Bob's upload must not reveal or reuse Alice's document.
        ResponseEntity<Map<String, Object>> res = upload(bob, "copy.txt", aliceFile);

        assertThat(res.getStatusCode().value()).isEqualTo(202);
        assertThat(res.getBody().get("id")).isNotEqualTo(aliceDoc);
        assertThat(listDocuments(alice).getBody()).hasSize(1);
    }

    /** ProblemDetail bodies include the request path ("instance"), which differs by design. */
    private static Map<String, Object> withoutInstance(Map<String, Object> body, Map<String, Object> reference) {
        Map<String, Object> copy = new java.util.HashMap<>(body);
        copy.put("instance", reference.get("instance"));
        return copy;
    }
}
