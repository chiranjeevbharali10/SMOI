package com.smoi.ingestion;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.smoi.support.DocumentApiTest;
import com.smoi.support.FaultInjectingEmbeddingProvider.Hang;
import com.smoi.support.TestFiles;
import org.junit.jupiter.api.Test;

import static com.smoi.support.TestFiles.paragraph;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * Failure handling in the ingestion queue (NFR-02.03, 02.04, 02.06, 06.02). Tests run with a
 * 5 s lease, 3 attempts and a 100 ms base backoff (see IntegrationTest).
 */
class IngestionReliabilityIT extends DocumentApiTest {

    /**
     * A worker claims a job and then stops making progress. This leaves the database exactly
     * as a crashed or killed worker does: the job is "running" and its lease is no longer renewed.
     * The test can't kill the JVM it runs in, so a hung thread stands in for the dead process.
     */
    @Test
    void jobFromAWorkerThatDiedMidJobIsCompletedByAnotherWorker() throws Exception {
        TestUser user = newUser();
        String marker = "HANG" + UUID.randomUUID().toString().replace("-", "");
        Hang hang = embeddingFaults.hangOnce(marker);

        String id = uploadNew(user, "crash.txt", TestFiles.txt(paragraph(marker, 80)));
        hang.awaitHung();
        assertThat(jobs(user, id)).singleElement().satisfies(j -> {
            assertThat(j.status()).isEqualTo("running");
            assertThat(j.attempts()).isEqualTo(1);
        });

        // After the lease runs out, another worker claims the job and finishes it.
        Map<String, Object> doc = awaitStatus(user, id, "indexed");
        assertThat(jobs(user, id)).singleElement().satisfies(j -> {
            assertThat(j.status()).isEqualTo("succeeded");
            assertThat(j.attempts()).isEqualTo(2);
        });
        long chunks = chunkRows(user, id);
        assertThat(chunks).isEqualTo(((Integer) doc.get("chunkCount")).longValue()).isPositive();

        // The stuck worker wakes up later. Its lease token no longer matches, so it must
        // abandon the job without writing anything.
        hang.release();
        hang.awaitResumed();
        Thread.sleep(500);
        assertThat(jobs(user, id)).singleElement().extracting(JobRow::status).isEqualTo("succeeded");
        assertThat(chunkRows(user, id)).isEqualTo(chunks);
        assertThat(getDocument(user, id).getBody()).containsEntry("status", "indexed");
    }

    @Test
    void temporaryEmbeddingFailuresAreRetriedUntilTheySucceed() {
        TestUser user = newUser();
        String marker = "FLAKY" + UUID.randomUUID().toString().replace("-", "");
        embeddingFaults.failNextCalls(marker, 2);

        String id = uploadNew(user, "flaky.txt", TestFiles.txt(paragraph(marker, 40)));

        awaitStatus(user, id, "indexed");
        assertThat(jobs(user, id)).singleElement().satisfies(j -> {
            assertThat(j.status()).isEqualTo("succeeded");
            assertThat(j.attempts()).isEqualTo(3);
            assertThat(j.lastError()).isNull();
        });
    }

    @Test
    void persistentFailureEndsInTheDeadLetterStateWithTheReason() {
        TestUser user = newUser();
        String marker = "DOWN" + UUID.randomUUID().toString().replace("-", "");
        embeddingFaults.failNextCalls(marker, Integer.MAX_VALUE);

        String id = uploadNew(user, "down.txt", TestFiles.txt(paragraph(marker, 40)));

        Map<String, Object> doc = awaitStatus(user, id, "failed");
        assertThat((String) doc.get("error"))
                .startsWith("Gave up after 3 attempts")
                .contains("Injected embedding failure for " + marker);
        assertThat(jobs(user, id)).singleElement().satisfies(j -> {
            assertThat(j.status()).isEqualTo("dead");
            assertThat(j.attempts()).isEqualTo(3);
            assertThat(j.lastError()).contains("Injected embedding failure");
        });
        assertThat(chunkRows(user, id)).isZero();
    }

    @Test
    void corruptFileGoesStraightToDeadLetterWithoutRetrying() {
        TestUser user = newUser();
        // Starts like a PDF, so upload accepts it, but the parser can't read it.
        byte[] corrupt = ("%PDF-1.7\n" + UUID.randomUUID() + "\nthis is not really a pdf").getBytes();

        String id = uploadNew(user, "broken.pdf", corrupt);

        Map<String, Object> doc = awaitStatus(user, id, "failed");
        assertThat((String) doc.get("error")).startsWith("Could not read the file");
        assertThat(doc).containsEntry("chunkCount", 0);
        assertThat(jobs(user, id)).singleElement().satisfies(j -> {
            assertThat(j.status()).isEqualTo("dead");
            assertThat(j.attempts()).isEqualTo(1); // a corrupt file won't parse on a second try either
            assertThat(j.lastError()).startsWith("Could not read the file");
        });
    }

    @Test
    void pdfWithoutTextFailsWithAnExplanation() {
        TestUser user = newUser();
        // Pages with no text at all, like a scanned document without OCR.
        String id = uploadNew(user, "scan.pdf", TestFiles.pdf(List.of(List.of(), List.of())));

        assertThat((String) awaitStatus(user, id, "failed").get("error")).contains("no extractable text");
    }

    @Test
    void manyConcurrentUploadsAreEachProcessedExactlyOnce() throws Exception {
        TestUser user = newUser();
        int documents = 20;
        ExecutorService clients = Executors.newFixedThreadPool(8);
        List<Future<String>> ids = new ArrayList<>();
        for (int i = 0; i < documents; i++) {
            String text = paragraph("concurrent " + i + " " + UUID.randomUUID(), 120);
            ids.add(clients.submit(() -> uploadNew(user, "doc.txt", TestFiles.txt(text))));
        }
        List<String> documentIds = new ArrayList<>();
        for (Future<String> id : ids) {
            documentIds.add(id.get());
        }
        clients.shutdown();

        for (String id : documentIds) {
            Map<String, Object> doc = awaitStatus(user, id, "indexed");
            // One claim per job: no job was picked up by two workers.
            assertThat(jobs(user, id)).singleElement().satisfies(j -> {
                assertThat(j.status()).isEqualTo("succeeded");
                assertThat(j.attempts()).isEqualTo(1);
            });
            assertThat(chunkRows(user, id)).isEqualTo(((Integer) doc.get("chunkCount")).longValue());
        }
    }

    @Test
    void retryingTheSameUploadConcurrentlyCreatesOneDocument() throws Exception {
        TestUser user = newUser();
        byte[] file = TestFiles.txt(paragraph("retry storm " + UUID.randomUUID(), 40));
        ExecutorService clients = Executors.newFixedThreadPool(5);
        List<Future<Integer>> statuses = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            statuses.add(clients.submit(() -> upload(user, "same.txt", file).getStatusCode().value()));
        }
        List<Integer> codes = new ArrayList<>();
        for (Future<Integer> status : statuses) {
            codes.add(status.get());
        }
        clients.shutdown();

        assertThat(codes).containsOnly(200, 202).containsOnlyOnce(202);
        List<Map<String, Object>> list = listDocuments(user).getBody();
        assertThat(list).hasSize(1);
        assertThat(jobs(user, list.getFirst().get("id"))).hasSize(1);
    }

    @Test
    void deletingADocumentWhileItIsBeingIndexedLeavesNoChunks() throws Exception {
        TestUser user = newUser();
        String marker = "MIDDELETE" + UUID.randomUUID().toString().replace("-", "");
        Hang hang = embeddingFaults.hangOnce(marker);
        String id = uploadNew(user, "racing.txt", TestFiles.txt(paragraph(marker, 80)));
        hang.awaitHung();

        assertThat(delete(user, id)).isEqualTo(204);
        hang.release();
        hang.awaitResumed();

        await().during(java.time.Duration.ofMillis(500)).atMost(java.time.Duration.ofSeconds(5))
                .until(() -> chunkRows(user, id) == 0);
        assertThat(jobs(user, id)).singleElement().extracting(JobRow::status).isEqualTo("cancelled");
    }
}
