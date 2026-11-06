package com.smoi.folder;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import com.smoi.support.DocumentApiTest;
import com.smoi.support.TestFiles;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * With OCR turned on (a fake sidecar here), a scanned PDF is indexed from the OCR text, and files
 * that were flagged needs-OCR before OCR was available are indexed by retry-ocr.
 */
@TestPropertySource(properties = "smoi.ocr.enabled=true")
class OcrFolderSyncIT extends DocumentApiTest {

    private static final String ROOT = "C:\\Scans";
    private static final AtomicBoolean OCR_UP = new AtomicBoolean(true);
    private static final AtomicInteger OCR_CALLS = new AtomicInteger();
    private static final HttpServer OCR = startFakeOcr();

    @DynamicPropertySource
    static void ocrUrl(DynamicPropertyRegistry registry) {
        // Its own database, so the other test contexts' workers (OCR off) never take these jobs.
        String url = createDatabase("ocr_folder_sync_it");
        registry.add("spring.datasource.url", () -> url);
        registry.add("smoi.ocr.base-url", () -> "http://127.0.0.1:" + OCR.getAddress().getPort());
        registry.add("smoi.ocr.timeout", () -> "PT5S");
    }

    @AfterEach
    void resetOcr() {
        OCR_UP.set(true);
    }

    @Test
    void aScannedPdfIsIndexedFromItsOcrText() {
        TestUser user = newUser();
        String folder = folderId(user);

        sync(user, folder, ROOT + "\\receipt.pdf", TestFiles.pdf(List.of(List.of(), List.of())));

        Map<String, Object> file = awaitFileStatus(user, folder, ROOT + "\\receipt.pdf", "done");
        List<Map<String, Object>> chunks = getChunks(user, file.get("documentId")).getBody();
        assertThat(chunks).isNotEmpty();
        assertThat((String) chunks.getFirst().get("content")).contains("The plumber came on Tuesday");
        assertThat(chunks.getFirst()).containsEntry("pageStart", 1);
    }

    @Test
    void anUnavailableSidecarIsRetriedNotFlagged() {
        TestUser user = newUser();
        String folder = folderId(user);
        OCR_UP.set(false);
        int before = OCR_CALLS.get();

        sync(user, folder, ROOT + "\\later.pdf", TestFiles.pdf(List.of(List.of())));
        await().atMost(Duration.ofSeconds(10)).until(() -> OCR_CALLS.get() > before);
        OCR_UP.set(true);

        awaitFileStatus(user, folder, ROOT + "\\later.pdf", "done");
    }

    @Test
    void retryOcrQueuesFilesThatNeededIt() {
        TestUser user = newUser();
        String folder = folderId(user);
        Object documentId = sync(user, folder, ROOT + "\\old-scan.pdf", TestFiles.pdf(List.of(List.of()))).get("documentId");
        awaitFileStatus(user, folder, ROOT + "\\old-scan.pdf", "done");
        // Pretend it was flagged before OCR was turned on (scoped by user_id like every query).
        jdbc.sql("UPDATE documents SET status = 'failed', error = 'It looks scanned and needs OCR.' WHERE id = :id AND user_id = :userId")
                .param("id", java.util.UUID.fromString(documentId.toString())).param("userId", user.id()).update();
        jdbc.sql("UPDATE folder_files SET status = 'needs_ocr' WHERE document_id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", java.util.UUID.fromString(documentId.toString())).param("userId", user.id()).update();

        Map<String, Object> res = http().post().uri("/api/folders/retry-ocr").header("Authorization", "Bearer " + user.token())
                .retrieve().body(JSON);

        assertThat(res).containsEntry("queued", 1);
        awaitFileStatus(user, folder, ROOT + "\\old-scan.pdf", "done");
        assertThat(getDocument(user, documentId).getBody()).containsEntry("status", "indexed");
    }

    // ---------- helpers ----------

    private static HttpServer startFakeOcr() {
        try {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/ocr", exchange -> {
                exchange.getRequestBody().readAllBytes();
                OCR_CALLS.incrementAndGet();
                byte[] body;
                int status;
                if (OCR_UP.get()) {
                    status = 200;
                    body = "{\"engine\":\"fake\",\"pages\":[\"The plumber came on Tuesday and fixed the kitchen tap.\\n\\nPaid in cash.\"]}"
                            .getBytes(StandardCharsets.UTF_8);
                } else {
                    status = 503;
                    body = "{\"detail\":\"starting\"}".getBytes(StandardCharsets.UTF_8);
                }
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(status, body.length);
                exchange.getResponseBody().write(body);
                exchange.close();
            });
            server.start();
            return server;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private String folderId(TestUser user) {
        return http().post().uri("/api/folders").header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.APPLICATION_JSON).body(Map.of("path", ROOT)).retrieve().body(JSON)
                .get("id").toString();
    }

    private Map<String, Object> sync(TestUser user, String folder, String path, byte[] content) {
        MultiValueMap<String, Object> parts = new LinkedMultiValueMap<>();
        parts.add("file", new ByteArrayResource(content) {
            @Override
            public String getFilename() {
                return path.substring(path.lastIndexOf('\\') + 1);
            }
        });
        parts.add("path", path);
        parts.add("modifiedTime", Instant.parse("2026-11-01T10:00:00Z").toString());
        return http().put().uri("/api/folders/{id}/files", folder).header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.MULTIPART_FORM_DATA).body(parts).retrieve().body(JSON);
    }

    private Map<String, Object> awaitFileStatus(TestUser user, String folder, String path, String status) {
        return await().atMost(INDEXING_TIMEOUT).pollInterval(Duration.ofMillis(50))
                .until(() -> http().get().uri("/api/folders/{id}/files", folder)
                                .header("Authorization", "Bearer " + user.token()).retrieve().body(JSON_LIST)
                                .stream().filter(f -> path.equals(f.get("path"))).findFirst().orElse(null),
                        f -> f != null && status.equals(f.get("status")));
    }
}
