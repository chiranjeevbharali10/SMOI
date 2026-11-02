package com.smoi.document;

import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.smoi.support.DocumentApiTest;
import com.smoi.support.TestFiles;
import com.smoi.support.TestFiles.DocxParagraph;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import static com.smoi.support.TestFiles.paragraph;
import static org.assertj.core.api.Assertions.assertThat;

/** Upload to indexed, for each supported format, plus duplicates, replace and delete (FR-06.01, 03, 04, 10). */
class DocumentIngestionIT extends DocumentApiTest {

    private static final Pattern PAGE_TAG = Pattern.compile("PAGE(\\d)TAG");

    @Test
    void uploadReturnsImmediatelyWithIdAndQueuedStatus() {
        TestUser user = newUser();
        ResponseEntity<Map<String, Object>> res = upload(user, "notes.txt", TestFiles.txt(paragraph("quick " + UUID.randomUUID(), 20)));

        assertThat(res.getStatusCode().value()).isEqualTo(202);
        assertThat(res.getHeaders().getLocation()).hasToString("/api/documents/" + res.getBody().get("id"));
        assertThat(res.getBody()).containsEntry("status", "queued").containsEntry("filename", "notes.txt")
                .containsEntry("mediaType", "text/plain").containsEntry("version", 1);
    }

    @Test
    void multiPagePdfIsIndexedWithCorrectPageNumbers() {
        TestUser user = newUser();
        // Every paragraph names its page, so each chunk's text says which pages it came from,
        // and the stored page range must match. The short paragraphs at the end of page 1 and
        // the start of page 2 fit into one chunk together, so one chunk spans two pages.
        List<List<String>> pages = List.of(
                List.of(paragraph("PAGE1TAG a", 30), "PAGE1TAG tail."),
                List.of("PAGE2TAG head.", paragraph("PAGE2TAG b", 30), paragraph("PAGE2TAG c", 30)),
                List.of(paragraph("PAGE3TAG a", 30), paragraph("PAGE3TAG b", 30)));
        String id = uploadNew(user, "report.pdf", TestFiles.pdf(pages));

        Map<String, Object> doc = awaitStatus(user, id, "indexed");
        List<Map<String, Object>> chunks = getChunks(user, id).getBody();

        assertThat(doc).containsEntry("mediaType", "application/pdf");
        assertThat(chunks).hasSize((Integer) doc.get("chunkCount")).hasSizeGreaterThanOrEqualTo(3);
        TreeSet<Integer> pagesSeen = new TreeSet<>();
        for (Map<String, Object> chunk : chunks) {
            TreeSet<Integer> mentioned = new TreeSet<>();
            Matcher m = PAGE_TAG.matcher((String) chunk.get("content"));
            while (m.find()) {
                mentioned.add(Integer.parseInt(m.group(1)));
            }
            assertThat(mentioned).as("chunk %s", chunk.get("index")).isNotEmpty();
            assertThat(chunk.get("pageStart")).as("pageStart of chunk %s", chunk.get("index")).isEqualTo(mentioned.first());
            assertThat(chunk.get("pageEnd")).as("pageEnd of chunk %s", chunk.get("index")).isEqualTo(mentioned.last());
            assertThat(chunk.get("embeddingModel")).isEqualTo("hashing-v1");
            pagesSeen.addAll(mentioned);
        }
        assertThat(pagesSeen).containsExactly(1, 2, 3);
        assertThat(chunks).anySatisfy(c -> {
            assertThat(c.get("pageStart")).isEqualTo(1);
            assertThat(c.get("pageEnd")).isEqualTo(2);
        });
        assertThat(chunks).extracting(c -> c.get("index")).isSorted();
    }

    @Test
    void docxChunksRecordTheirHeadingPath() {
        TestUser user = newUser();
        byte[] docx = TestFiles.docx(List.of(
                DocxParagraph.heading(1, "Field Guide"),
                DocxParagraph.text(paragraph("intro " + UUID.randomUUID(), 30)),
                DocxParagraph.heading(2, "Frogs"),
                DocxParagraph.text(paragraph("frogs are amphibians", 30)),
                DocxParagraph.heading(2, "Toads"),
                DocxParagraph.text(paragraph("toads have dry skin", 30))));
        String id = uploadNew(user, "guide.docx", docx);

        awaitStatus(user, id, "indexed");
        List<Map<String, Object>> chunks = getChunks(user, id).getBody();

        assertThat(chunks).extracting(c -> c.get("section"))
                .containsExactly("Field Guide", "Field Guide > Frogs", "Field Guide > Toads");
        assertThat((String) chunks.get(1).get("content")).startsWith("Frogs\n\n").contains("frogs are amphibians");
        assertThat(chunks).allSatisfy(c -> assertThat(c.get("pageStart")).isNull());
    }

    @Test
    void plainTextIsSplitIntoParagraphChunks() {
        TestUser user = newUser();
        // Each paragraph is under the 100-token test limit, but no two fit together.
        String text = paragraph("first " + UUID.randomUUID(), 25) + "\n\n" + paragraph("second", 30) + "\r\n\r\n"
                + paragraph("third", 30);
        String id = uploadNew(user, "notes.txt", TestFiles.txt(text));

        awaitStatus(user, id, "indexed");
        List<Map<String, Object>> chunks = getChunks(user, id).getBody();

        assertThat(chunks).hasSize(3);
        assertThat((String) chunks.get(1).get("content")).startsWith("second opens this paragraph.");
        assertThat(chunks).allSatisfy(c -> assertThat((Integer) c.get("tokenCount")).isLessThanOrEqualTo(100));
    }

    @Test
    void uploadingTheSameFileAgainReturnsTheExistingDocumentAndCreatesNoChunks() {
        TestUser user = newUser();
        byte[] file = TestFiles.txt(paragraph("dup " + UUID.randomUUID(), 80));
        String id = uploadNew(user, "a.txt", file);
        awaitStatus(user, id, "indexed");
        long chunksBefore = chunkRows(user, id);

        // Same bytes, different filename: this is what a client retrying after a timeout sends.
        ResponseEntity<Map<String, Object>> again = upload(user, "a-copy.txt", file);

        assertThat(again.getStatusCode().value()).isEqualTo(200);
        assertThat(again.getBody()).containsEntry("id", id).containsEntry("filename", "a.txt");
        assertThat(listDocuments(user).getBody()).hasSize(1);
        assertThat(jobs(user, id)).hasSize(1);
        assertThat(chunkRows(user, id)).isEqualTo(chunksBefore);
    }

    @Test
    void replacingTheFileSwapsTheChunksAndKeepsTheId() {
        TestUser user = newUser();
        String id = uploadNew(user, "v1.txt", TestFiles.txt(paragraph("ORIGINALTEXT " + UUID.randomUUID(), 80)));
        awaitStatus(user, id, "indexed");

        ResponseEntity<Map<String, Object>> res = replace(user, id, "v2.txt",
                TestFiles.txt(paragraph("REPLACEMENTTEXT " + UUID.randomUUID(), 80)));
        assertThat(res.getStatusCode().value()).isEqualTo(202);
        assertThat(res.getBody()).containsEntry("version", 2).containsEntry("status", "queued");

        Map<String, Object> doc = awaitStatus(user, id, "indexed");
        List<Map<String, Object>> chunks = getChunks(user, id).getBody();

        assertThat(doc).containsEntry("version", 2).containsEntry("filename", "v2.txt");
        assertThat(chunks).isNotEmpty()
                .allSatisfy(c -> assertThat((String) c.get("content")).doesNotContain("ORIGINALTEXT"))
                .anySatisfy(c -> assertThat((String) c.get("content")).contains("REPLACEMENTTEXT"));
        assertThat(chunkRows(user, id)).isEqualTo(chunks.size());
        assertThat(jobs(user, id)).extracting(JobRow::status).containsExactly("succeeded", "succeeded");
    }

    @Test
    void replacingWithIdenticalContentDoesNothing() {
        TestUser user = newUser();
        byte[] file = TestFiles.txt(paragraph("same " + UUID.randomUUID(), 40));
        String id = uploadNew(user, "a.txt", file);
        awaitStatus(user, id, "indexed");

        ResponseEntity<Map<String, Object>> res = replace(user, id, "a.txt", file);

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody()).containsEntry("version", 1);
        assertThat(jobs(user, id)).hasSize(1);
    }

    @Test
    void replacingWithTheContentOfAnotherDocumentIsAConflict() {
        TestUser user = newUser();
        byte[] first = TestFiles.txt(paragraph("first " + UUID.randomUUID(), 40));
        uploadNew(user, "first.txt", first);
        String second = uploadNew(user, "second.txt", TestFiles.txt(paragraph("second " + UUID.randomUUID(), 40)));

        assertThat(replace(user, second, "first.txt", first).getStatusCode().value()).isEqualTo(409);
    }

    @Test
    void deletingADocumentRemovesItsChunksAndHidesIt() {
        TestUser user = newUser();
        byte[] file = TestFiles.txt(paragraph("delete me " + UUID.randomUUID(), 80));
        String id = uploadNew(user, "gone.txt", file);
        awaitStatus(user, id, "indexed");
        assertThat(chunkRows(user, id)).isPositive();

        assertThat(delete(user, id)).isEqualTo(204);

        assertThat(chunkRows(user, id)).isZero();
        assertThat(getDocument(user, id).getStatusCode().value()).isEqualTo(404);
        assertThat(chunksStatus(user, id)).isEqualTo(404);
        assertThat(listDocuments(user).getBody()).isEmpty();
        assertThat(delete(user, id)).isEqualTo(404);
        // The stored file is dropped too, not just hidden.
        assertThat(jdbc.sql("SELECT content IS NULL FROM documents WHERE id = :id AND user_id = :userId")
                .param("id", UUID.fromString(id)).param("userId", user.id()).query(Boolean.class).single()).isTrue();
        // Uploading the same file again starts a fresh document.
        assertThat(upload(user, "gone.txt", file).getStatusCode().value()).isEqualTo(202);
    }

    @Test
    void listShowsOnlyActiveDocumentsNewestFirst() {
        TestUser user = newUser();
        String older = uploadNew(user, "older.txt", TestFiles.txt(paragraph("older " + UUID.randomUUID(), 20)));
        String newer = uploadNew(user, "newer.txt", TestFiles.txt(paragraph("newer " + UUID.randomUUID(), 20)));

        assertThat(listDocuments(user).getBody()).extracting(d -> d.get("id")).containsExactly(newer, older);
    }

    @Test
    void unsupportedFileTypeIsRejectedByContentNotByName() {
        TestUser user = newUser();
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n', 0, 0, 0, 13, 'I', 'H', 'D', 'R'};

        assertThat(upload(user, "picture-renamed.txt", png).getStatusCode().value()).isEqualTo(415);
        assertThat(listDocuments(user).getBody()).isEmpty();
    }

    @Test
    void emptyFileIsRejected() {
        assertThat(upload(newUser(), "empty.txt", new byte[0]).getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void fileOverTheSizeLimitIsRejected() {
        byte[] tooBig = TestFiles.txt("a ".repeat(1_100_000)); // 2.2 MB; the test limit is 2 MB

        assertThat(upload(newUser(), "big.txt", tooBig).getStatusCode().value()).isEqualTo(413);
    }

    @Test
    void documentEndpointsRequireAuthentication() {
        assertThat(http().get().uri("/api/documents").retrieve().toBodilessEntity().getStatusCode().value()).isEqualTo(401);
    }
}
