package com.smoi.ingestion;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import com.smoi.document.ChunkRepository;
import com.smoi.document.DocumentRepository;
import com.smoi.embedding.EmbeddingException;
import com.smoi.embedding.EmbeddingProperties;
import com.smoi.embedding.EmbeddingProvider;
import com.smoi.folder.FolderFile;
import com.smoi.folder.FolderRepository;
import com.smoi.ingestion.chunking.ChunkDraft;
import com.smoi.ingestion.chunking.Chunker;
import com.smoi.ingestion.parsing.Block;
import com.smoi.ingestion.parsing.DocumentParseException;
import com.smoi.ingestion.parsing.DocumentParser;
import com.smoi.ingestion.parsing.NeedsOcrException;
import com.smoi.ingestion.ocr.OcrClient;
import com.smoi.observability.Spans;
import com.smoi.resilience.ProviderCircuitBreakers;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Runs one claimed job through the stages parse, clean, chunk, embed, store, and records the
 * outcome.
 *
 * <p>The slow stages (parsing and embedding) run outside any database transaction, so no row
 * stays locked while Ollama works. Only the final write is a transaction, and it is short:
 * delete the old chunks, insert the new ones, mark the document indexed. Other queries keep
 * seeing the old chunks until that transaction commits, so a re-indexed document is never
 * missing from search, even for a moment.
 */
@Service
public class IngestionPipeline {

    private static final Logger log = LoggerFactory.getLogger(IngestionPipeline.class);

    private final JobQueue queue;
    private final DocumentRepository documents;
    private final ChunkRepository chunks;
    private final DocumentParser parser;
    private final Chunker chunker;
    private final EmbeddingProvider embeddings;
    private final IngestionProperties props;
    private final int batchSize;
    private final TransactionTemplate tx;
    private final ProviderCircuitBreakers breakers;
    private final MeterRegistry meters;
    private final Spans spans;
    private final FolderRepository folderFiles;
    private final Optional<OcrClient> ocr;

    public IngestionPipeline(JobQueue queue, DocumentRepository documents, ChunkRepository chunks, DocumentParser parser,
                             Chunker chunker, EmbeddingProvider embeddings, IngestionProperties props,
                             EmbeddingProperties embeddingProps, TransactionTemplate tx,
                             ProviderCircuitBreakers breakers, MeterRegistry meters, Spans spans,
                             FolderRepository folderFiles, Optional<OcrClient> ocr) {
        this.folderFiles = folderFiles;
        this.ocr = ocr;
        this.spans = spans;
        this.breakers = breakers;
        this.meters = meters;
        this.queue = queue;
        this.documents = documents;
        this.chunks = chunks;
        this.parser = parser;
        this.chunker = chunker;
        this.embeddings = embeddings;
        this.props = props;
        this.batchSize = embeddingProps.batchSize();
        this.tx = tx;
    }

    /**
     * Processes the job and records success, retry, dead-letter or cancellation. Only a database
     * failure while recording the outcome escapes; the job's lease then expires and it is retried.
     */
    public void run(IngestionJob job) {
        // One trace per job attempt (a worker has no incoming request to continue).
        spans.in("ingestion.job", () -> runTraced(job));
    }

    private void runTraced(IngestionJob job) {
        long start = System.nanoTime();
        String outcome = "retry";
        try {
            if (job.attempts() > job.maxAttempts()) {
                // The previous worker claimed the final attempt and then stopped renewing its
                // lease (crash, kill, or hang). Don't start another attempt.
                fail(job, "Gave up after " + job.maxAttempts()
                        + " attempts: the worker stopped responding during the last attempt");
                outcome = "dead";
                return;
            }
            outcome = process(job);
        } catch (LeaseLostException e) {
            // Another worker owns the job now. Writing anything would race with it.
            log.warn("Abandoning job {}: {}", job.id(), e.getMessage());
            outcome = "lease_lost";
        } catch (DocumentParseException e) {
            // The file itself is the problem, so retrying can't help.
            fail(job, e.getMessage());
            outcome = "dead";
        } catch (Exception e) {
            // Anything else (embedding provider down, database hiccup) may pass, so retry.
            outcome = retryOrFail(job, describe(e)) ? "retry" : "dead";
        } finally {
            // smoi_ingestion_job_seconds{outcome=...}: duration and count of every attempt.
            Timer.builder("smoi.ingestion.job").tag("outcome", outcome).register(meters)
                    .record(Duration.ofNanos(System.nanoTime() - start));
        }
    }

    private void stage(String name, long startNanos) {
        Timer.builder("smoi.ingestion.stage").tag("stage", name).register(meters)
                .record(Duration.ofNanos(System.nanoTime() - startNanos));
    }

    /** Returns the outcome for metrics: succeeded or cancelled. */
    private String process(IngestionJob job) {
        Optional<DocumentRepository.Content> content = tx.execute(status ->
                documents.startProcessing(job.userId(), job.documentId(), job.documentVersion()));
        if (content.isEmpty()) {
            queue.markCancelled(job, "The document was deleted or replaced before indexing started");
            return "cancelled";
        }

        // Parse and clean, then chunk.
        long t = System.nanoTime();
        List<Block> blocks = spans.in("ingestion.parse", () -> parseOrOcr(content.get()));
        stage("parse", t);
        t = System.nanoTime();
        List<ChunkDraft> drafts = spans.in("ingestion.chunk", () -> chunker.chunk(blocks));
        stage("chunk", t);
        queue.renewLease(job);

        // Embed, in batches. Renewing the lease before each batch is the worker's heartbeat.
        t = System.nanoTime();
        List<float[]> vectors = new ArrayList<>(drafts.size());
        for (int from = 0; from < drafts.size(); from += batchSize) {
            queue.renewLease(job);
            List<String> texts = drafts.subList(from, Math.min(drafts.size(), from + batchSize))
                    .stream().map(ChunkDraft::text).toList();
            // Through the breaker: while the embedding provider is down, jobs fail fast and back off
            // instead of each waiting for the full timeout.
            vectors.addAll(checked(spans.in("ingestion.embed", () -> breakers.embedding(() -> embeddings.embedDocuments(texts))),
                    texts.size()));
        }
        stage("embed", t);

        // Store: one short transaction.
        t = System.nanoTime();
        boolean[] cancelled = {false};
        tx.executeWithoutResult(status -> {
            // Lock order: document row, then job row. Replace and delete use the same order,
            // so they can't deadlock with this transaction.
            if (!documents.lockVersion(job.userId(), job.documentId(), job.documentVersion())) {
                queue.markCancelled(job, "The document was deleted or replaced during indexing");
                cancelled[0] = true;
                return;
            }
            if (!queue.markSucceeded(job)) {
                throw new LeaseLostException(job); // rolls the transaction back
            }
            chunks.deleteForDocument(job.userId(), job.documentId());
            chunks.insertAll(job.userId(), job.documentId(), drafts, vectors, embeddings.modelId());
            documents.markIndexed(job.userId(), job.documentId(), job.documentVersion(), drafts.size());
            folderFiles.setStatusForDocument(job.userId(), job.documentId(), FolderFile.DONE, null);
        });
        stage("store", t);
        if (cancelled[0]) {
            return "cancelled";
        }
        Counter.builder("smoi.ingestion.chunks").register(meters).increment(drafts.size());
        log.info("Indexed document {} version {}: {} chunks", job.documentId(), job.documentVersion(), drafts.size());
        return "succeeded";
    }

    /** Parses the file; a scanned PDF goes through OCR when the sidecar is enabled. */
    private List<Block> parseOrOcr(DocumentRepository.Content content) {
        try {
            return parser.parse(content.bytes(), content.mediaType());
        } catch (NeedsOcrException e) {
            if (ocr.isEmpty()) {
                throw e;
            }
            return parser.blocksFromPages(ocr.get().recognise(content.bytes()));
        }
    }

    private List<float[]> checked(List<float[]> vectors, int expected) {
        if (vectors.size() != expected) {
            throw new EmbeddingException("Embedding provider returned " + vectors.size() + " vectors for " + expected + " texts");
        }
        for (float[] vector : vectors) {
            if (vector.length != EmbeddingProvider.DIMENSIONS) {
                throw new EmbeddingException(embeddings.modelId() + " returned " + vector.length
                        + " dimensions, but the database stores " + EmbeddingProvider.DIMENSIONS
                        + ". Use a " + EmbeddingProvider.DIMENSIONS + "-dimension model (see docs/adr/0006).");
            }
        }
        return vectors;
    }

    /** Returns true if the job will be retried, false if it was moved to dead-letter. */
    private boolean retryOrFail(IngestionJob job, String error) {
        if (job.attempts() >= job.maxAttempts()) {
            fail(job, "Gave up after " + job.attempts() + " attempts. Last error: " + error);
            return false;
        }
        tx.executeWithoutResult(status -> {
            documents.markQueued(job.userId(), job.documentId(), job.documentVersion());
            if (!queue.scheduleRetry(job, error, props.backoffAfter(job.attempts()))) {
                status.setRollbackOnly();
            }
        });
        log.warn("Job {} attempt {} failed, will retry: {}", job.id(), job.attempts(), error);
        return true;
    }

    /**
     * Dead-letter: the job stops, the document shows "failed" with the reason, and any chunks
     * from an earlier version are removed, so search never returns text that no longer matches
     * the stored file.
     */
    private void fail(IngestionJob job, String error) {
        tx.executeWithoutResult(status -> {
            boolean current = documents.markFailed(job.userId(), job.documentId(), job.documentVersion(),
                    JobQueue.truncate(error));
            if (!queue.markDead(job, error)) {
                status.setRollbackOnly();
                return;
            }
            if (current) {
                chunks.deleteForDocument(job.userId(), job.documentId());
                folderFiles.setStatusForDocument(job.userId(), job.documentId(),
                        error.contains(NeedsOcrException.MARKER) ? FolderFile.NEEDS_OCR : FolderFile.FAILED,
                        JobQueue.truncate(error));
            }
        });
        log.warn("Job {} moved to dead-letter: {}", job.id(), error);
    }

    private static String describe(Exception e) {
        String message = e.getMessage();
        return message == null ? e.getClass().getSimpleName() : message;
    }
}
