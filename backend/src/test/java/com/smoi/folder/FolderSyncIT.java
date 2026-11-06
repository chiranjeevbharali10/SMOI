package com.smoi.folder;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.smoi.support.DocumentApiTest;
import com.smoi.support.TestFiles;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;

import static com.smoi.support.TestFiles.paragraph;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * Folder sync through the HTTP API, against real Postgres and the real ingestion workers: each
 * file event the desktop can report (new, unchanged, edited, renamed, moved, deleted, failed),
 * plus shared content, hand uploads, scanned PDFs, retries and folder removal.
 */
class FolderSyncIT extends DocumentApiTest {

    private static final String ROOT = "C:\\Users\\test\\Notes";
    private static final Instant T1 = Instant.parse("2026-11-01T10:00:00Z");
    private static final Instant T2 = Instant.parse("2026-11-02T10:00:00Z");

    // ---------- folders ----------

    @Test
    void addListAndRemoveFolders() {
        TestUser user = newUser();
        String id = addFolder(user, ROOT + "\\").getBody().get("id").toString();

        Map<String, Object> list = folders(user);
        assertThat(list).containsEntry("total", 0).containsEntry("ocrEnabled", false);
        assertThat((List<?>) list.get("folders")).singleElement()
                .satisfies(f -> assertThat(((Map<?, ?>) f).get("path")).isEqualTo(ROOT)); // trailing slash removed

        assertThat(status(http().delete().uri("/api/folders/{id}", id).header("Authorization", bearer(user))
                .retrieve().toBodilessEntity())).isEqualTo(204);
        assertThat((List<?>) folders(user).get("folders")).isEmpty();
    }

    @Test
    void overlappingFoldersAreRejected() {
        TestUser user = newUser();
        addFolder(user, ROOT);

        assertThat(status(addFolder(user, ROOT))).isEqualTo(409);
        assertThat(status(addFolder(user, "c:/users/TEST/notes"))).isEqualTo(409);    // same folder, other spelling
        assertThat(status(addFolder(user, ROOT + "\\Work"))).isEqualTo(409);           // inside
        assertThat(status(addFolder(user, "C:\\Users\\test"))).isEqualTo(409);         // contains
        assertThat(status(addFolder(user, "C:\\Users\\test\\Notes2"))).isEqualTo(201); // a sibling is fine
    }

    @Test
    void relativeOrEmptyPathsAreRejected() {
        TestUser user = newUser();
        assertThat(status(addFolder(user, "Documents"))).isEqualTo(400);
        assertThat(status(addFolder(user, "   "))).isEqualTo(400);
    }

    @Test
    void anotherUsersFolderLooksMissing() {
        TestUser owner = newUser();
        TestUser other = newUser();
        String id = folderId(owner, ROOT);

        assertThat(status(sync(other, id, ROOT + "\\a.txt", T1, txt("private notes")))).isEqualTo(404);
        assertThat(status(http().get().uri("/api/folders/{id}/files", id).header("Authorization", bearer(other))
                .retrieve().toBodilessEntity())).isEqualTo(404);
    }

    // ---------- file events ----------

    @Test
    void newFileIsIndexedAtBackgroundPriorityAndCounted() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);

        Map<String, Object> file = sync(user, folder, ROOT + "\\garden.txt", T1, txt("garden plans")).getBody();

        assertThat(file).containsEntry("status", "pending").containsEntry("path", ROOT + "\\garden.txt");
        assertThat(file.get("contentHash")).isNotNull();
        awaitFileStatus(user, folder, ROOT + "\\garden.txt", "done");
        Object documentId = file.get("documentId");
        assertThat(getDocument(user, documentId).getBody()).containsEntry("status", "indexed")
                .containsEntry("filename", "garden.txt");
        assertThat(jobPriorities(user, documentId)).containsExactly(10);
        assertThat(folders(user)).containsEntry("total", 1).containsEntry("done", 1).containsEntry("failed", 0);
    }

    @Test
    void unchangedContentOnlyUpdatesTheModifiedTime() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        byte[] content = txt("unchanged notes");
        Object documentId = sync(user, folder, ROOT + "\\a.txt", T1, content).getBody().get("documentId");
        awaitFileStatus(user, folder, ROOT + "\\a.txt", "done");

        Map<String, Object> again = sync(user, folder, ROOT + "\\a.txt", T2, content).getBody();

        assertThat(again).containsEntry("documentId", documentId).containsEntry("status", "done")
                .containsEntry("modifiedTime", T2.toString());
        assertThat(jobs(user, documentId)).hasSize(1);
    }

    @Test
    void touchRecordsMetadataWithoutSendingTheFile() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        sync(user, folder, ROOT + "\\a.txt", T1, txt("touch me"));

        Map<String, Object> touched = post(user, "/api/folders/files/touch",
                Map.of("path", ROOT + "\\a.txt", "modifiedTime", T2.toString(), "sizeBytes", 999)).getBody();

        assertThat(touched).containsEntry("modifiedTime", T2.toString()).containsEntry("sizeBytes", 999);
        assertThat(status(post(user, "/api/folders/files/touch",
                Map.of("path", ROOT + "\\missing.txt", "modifiedTime", T2.toString(), "sizeBytes", 1)))).isEqualTo(404);
    }

    @Test
    void editReindexesTheSameDocument() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        String path = ROOT + "\\plan.txt";
        Object documentId = sync(user, folder, path, T1, txt("first version about tomatoes")).getBody().get("documentId");
        awaitFileStatus(user, folder, path, "done");

        Map<String, Object> edited = sync(user, folder, path, T2, txt("second version about cucumbers")).getBody();

        assertThat(edited).containsEntry("documentId", documentId);
        awaitFileStatus(user, folder, path, "done");
        assertThat(getDocument(user, documentId).getBody()).containsEntry("version", 2);
        assertThat(getChunks(user, documentId).getBody())
                .allSatisfy(c -> assertThat((String) c.get("content")).contains("cucumbers").doesNotContain("tomatoes"));
    }

    @Test
    void renameChangesThePathWithoutReindexing() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        Object documentId = sync(user, folder, ROOT + "\\old name.txt", T1, txt("renamed notes")).getBody().get("documentId");
        awaitFileStatus(user, folder, ROOT + "\\old name.txt", "done");

        Map<String, Object> moved = move(user, ROOT + "\\old name.txt", folder, ROOT + "\\new name.txt").getBody();

        assertThat(moved).containsEntry("path", ROOT + "\\new name.txt").containsEntry("documentId", documentId)
                .containsEntry("status", "done");
        assertThat(getDocument(user, documentId).getBody()).containsEntry("filename", "new name.txt")
                .containsEntry("version", 1);
        assertThat(jobs(user, documentId)).hasSize(1);
        assertThat(files(user, folder)).extracting(f -> f.get("path")).containsExactly(ROOT + "\\new name.txt");
    }

    @Test
    void moveToAnotherFolderKeepsTheIndex() {
        TestUser user = newUser();
        String from = folderId(user, ROOT);
        String to = folderId(user, "D:\\Archive");
        Object documentId = sync(user, from, ROOT + "\\a.txt", T1, txt("moving notes")).getBody().get("documentId");

        Map<String, Object> moved = move(user, ROOT + "\\a.txt", to, "D:\\Archive\\2026\\a.txt").getBody();

        assertThat(moved).containsEntry("folderId", to).containsEntry("documentId", documentId);
        assertThat(files(user, from)).isEmpty();
        assertThat(files(user, to)).hasSize(1);
        assertThat(status(move(user, "D:\\Archive\\2026\\a.txt", to, "E:\\elsewhere\\a.txt"))).isEqualTo(400);
    }

    @Test
    void moveOntoAnExistingFileReplacesIt() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        Object kept = sync(user, folder, ROOT + "\\a.txt", T1, txt("the file that moves")).getBody().get("documentId");
        Object overwritten = sync(user, folder, ROOT + "\\b.txt", T1, txt("the file that is overwritten")).getBody().get("documentId");

        move(user, ROOT + "\\a.txt", folder, ROOT + "\\b.txt");

        assertThat(files(user, folder)).singleElement().satisfies(f -> assertThat(f).containsEntry("documentId", kept));
        assertThat(getDocument(user, overwritten).getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void deleteRemovesTheDocumentAndItsChunks() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        Object documentId = sync(user, folder, ROOT + "\\gone.txt", T1, txt("soon deleted")).getBody().get("documentId");
        awaitFileStatus(user, folder, ROOT + "\\gone.txt", "done");

        assertThat(status(post(user, "/api/folders/files/delete", Map.of("path", ROOT + "\\gone.txt")))).isEqualTo(204);

        assertThat(files(user, folder)).isEmpty();
        assertThat(getDocument(user, documentId).getStatusCode().value()).isEqualTo(404);
        assertThat(chunkRows(user, documentId)).isZero();
        // Idempotent: the desktop may report the same deletion twice.
        assertThat(status(post(user, "/api/folders/files/delete", Map.of("path", ROOT + "\\gone.txt")))).isEqualTo(204);
    }

    @Test
    void identicalFilesShareOneDocumentUntilTheLastIsDeleted() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        byte[] content = txt("a copy kept in two places");
        Object first = sync(user, folder, ROOT + "\\a.txt", T1, content).getBody().get("documentId");
        Object second = sync(user, folder, ROOT + "\\copy\\a.txt", T1, content).getBody().get("documentId");
        assertThat(second).isEqualTo(first);

        post(user, "/api/folders/files/delete", Map.of("path", ROOT + "\\a.txt"));
        assertThat(getDocument(user, first).getStatusCode().value()).isEqualTo(200);

        post(user, "/api/folders/files/delete", Map.of("path", ROOT + "\\copy\\a.txt"));
        assertThat(getDocument(user, first).getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void editingOneOfTwoIdenticalFilesLeavesTheOtherAlone() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        byte[] content = txt("shared content before an edit");
        Object shared = sync(user, folder, ROOT + "\\a.txt", T1, content).getBody().get("documentId");
        sync(user, folder, ROOT + "\\b.txt", T1, content);

        Object edited = sync(user, folder, ROOT + "\\b.txt", T2, txt("b has its own content now")).getBody().get("documentId");

        assertThat(edited).isNotEqualTo(shared);
        assertThat(getDocument(user, shared).getBody()).containsEntry("version", 1);
    }

    @Test
    void aHandUploadedDocumentSurvivesDeletingAFileWithTheSameContent() {
        TestUser user = newUser();
        byte[] content = txt("uploaded by hand first");
        String uploaded = uploadNew(user, "mine.txt", content);
        String folder = folderId(user, ROOT);
        assertThat(sync(user, folder, ROOT + "\\mine.txt", T1, content).getBody()).containsEntry("documentId", uploaded);

        post(user, "/api/folders/files/delete", Map.of("path", ROOT + "\\mine.txt"));
        removeFolder(user, folder);

        assertThat(getDocument(user, uploaded).getStatusCode().value()).isEqualTo(200);
    }

    @Test
    void removingAFolderRemovesItsDocuments() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        Object a = sync(user, folder, ROOT + "\\a.txt", T1, txt("folder file a")).getBody().get("documentId");
        Object b = sync(user, folder, ROOT + "\\sub\\b.txt", T1, txt("folder file b")).getBody().get("documentId");

        removeFolder(user, folder);

        assertThat(getDocument(user, a).getStatusCode().value()).isEqualTo(404);
        assertThat(getDocument(user, b).getStatusCode().value()).isEqualTo(404);
        assertThat(folders(user)).containsEntry("total", 0);
    }

    @Test
    void aFileOutsideTheFolderIsRejected() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        assertThat(status(sync(user, folder, "C:\\Users\\test\\Other\\a.txt", T1, txt("x")))).isEqualTo(400);
        assertThat(status(sync(user, folder, ROOT, T1, txt("the folder itself")))).isEqualTo(400);
    }

    // ---------- failures ----------

    @Test
    void scannedPdfIsFlaggedNeedsOcr() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);

        sync(user, folder, ROOT + "\\scan.pdf", T1, TestFiles.pdf(List.of(List.of(), List.of("7"))));

        Map<String, Object> file = awaitFileStatus(user, folder, ROOT + "\\scan.pdf", "needs_ocr");
        assertThat((String) file.get("error")).contains("needs OCR");
        assertThat(folders(user)).containsEntry("needsOcr", 1).containsEntry("failed", 0);
        assertThat(status(post(user, "/api/folders/retry-ocr", Map.of()))).isEqualTo(409); // OCR is off here
    }

    @Test
    void unsupportedAndUnsendableFilesCountAsFailed() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);

        Map<String, Object> zip = sync(user, folder, ROOT + "\\a.pdf", T1, new byte[]{'P', 'K', 3, 4, 0, 0}).getBody();
        Map<String, Object> big = post(user, "/api/folders/" + folder + "/files/failed", Map.of(
                "path", ROOT + "\\huge.pdf", "modifiedTime", T1.toString(), "sizeBytes", 90_000_000,
                "error", "Larger than 25 MB")).getBody();

        assertThat(zip).containsEntry("status", "failed").containsEntry("documentId", null);
        assertThat((String) zip.get("error")).contains("Unsupported file type");
        assertThat(big).containsEntry("status", "failed").containsEntry("error", "Larger than 25 MB");
        assertThat(folders(user)).containsEntry("total", 2).containsEntry("failed", 2);
    }

    @Test
    void aFileThatFailsAfterBeingIndexedReleasesItsOldDocument() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        Object documentId = sync(user, folder, ROOT + "\\a.txt", T1, txt("indexed then too big")).getBody().get("documentId");

        post(user, "/api/folders/" + folder + "/files/failed", Map.of(
                "path", ROOT + "\\a.txt", "modifiedTime", T2.toString(), "sizeBytes", 90_000_000, "error", "Too large"));

        assertThat(getDocument(user, documentId).getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void aTransientIndexingFailureIsRetriedAndTheFileEndsDone() {
        TestUser user = newUser();
        String folder = folderId(user, ROOT);
        String marker = "retry-marker-" + UUID.randomUUID();
        embeddingFaults.failNextCalls(marker, 2);

        Object documentId = sync(user, folder, ROOT + "\\flaky.txt", T1, txt(marker)).getBody().get("documentId");

        awaitFileStatus(user, folder, ROOT + "\\flaky.txt", "done");
        assertThat(jobs(user, documentId)).singleElement().satisfies(j -> assertThat(j.attempts()).isEqualTo(3));
    }

    // ---------- helpers ----------

    private static byte[] txt(String tag) {
        return TestFiles.txt(paragraph(tag + " " + UUID.randomUUID(), 40));
    }

    private static String bearer(TestUser user) {
        return "Bearer " + user.token();
    }

    private static int status(ResponseEntity<?> res) {
        return res.getStatusCode().value();
    }

    private ResponseEntity<Map<String, Object>> addFolder(TestUser user, String path) {
        return post(user, "/api/folders", Map.of("path", path));
    }

    private String folderId(TestUser user, String path) {
        ResponseEntity<Map<String, Object>> res = addFolder(user, path);
        assertThat(status(res)).as("add folder, body %s", res.getBody()).isEqualTo(201);
        return res.getBody().get("id").toString();
    }

    private void removeFolder(TestUser user, String folder) {
        assertThat(status(http().delete().uri("/api/folders/{id}", folder).header("Authorization", bearer(user))
                .retrieve().toBodilessEntity())).isEqualTo(204);
    }

    private Map<String, Object> folders(TestUser user) {
        return http().get().uri("/api/folders").header("Authorization", bearer(user)).retrieve().body(JSON);
    }

    private List<Map<String, Object>> files(TestUser user, String folder) {
        return http().get().uri("/api/folders/{id}/files", folder).header("Authorization", bearer(user))
                .retrieve().body(JSON_LIST);
    }

    private ResponseEntity<Map<String, Object>> post(TestUser user, String uri, Map<String, ?> body) {
        return http().post().uri(uri).header("Authorization", bearer(user)).contentType(MediaType.APPLICATION_JSON)
                .body(body).retrieve().toEntity(JSON);
    }

    private ResponseEntity<Map<String, Object>> move(TestUser user, String from, String toFolder, String to) {
        return post(user, "/api/folders/files/move", Map.of("fromPath", from, "toFolderId", toFolder, "toPath", to));
    }

    private ResponseEntity<Map<String, Object>> sync(TestUser user, String folder, String path, Instant modified,
                                                     byte[] content) {
        MultiValueMap<String, Object> parts = new LinkedMultiValueMap<>();
        parts.add("file", new ByteArrayResource(content) {
            @Override
            public String getFilename() {
                return path.substring(path.lastIndexOf('\\') + 1);
            }
        });
        parts.add("path", path);
        parts.add("modifiedTime", modified.toString());
        return http().put().uri("/api/folders/{id}/files", folder).header("Authorization", bearer(user))
                .contentType(MediaType.MULTIPART_FORM_DATA).body(parts).retrieve().toEntity(JSON);
    }

    private Map<String, Object> awaitFileStatus(TestUser user, String folder, String path, String status) {
        return await().atMost(INDEXING_TIMEOUT).pollInterval(Duration.ofMillis(50))
                .until(() -> files(user, folder).stream().filter(f -> path.equals(f.get("path"))).findFirst().orElse(null),
                        f -> f != null && status.equals(f.get("status")));
    }

    private List<Integer> jobPriorities(TestUser user, Object documentId) {
        return jdbc.sql("""
                        SELECT priority FROM ingestion_jobs
                         WHERE user_id = :userId AND document_id = :documentId AND deleted_at IS NULL
                        """)
                .param("userId", user.id())
                .param("documentId", UUID.fromString(documentId.toString()))
                .query(Integer.class)
                .list();
    }
}
