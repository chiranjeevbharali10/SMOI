package com.smoi.ingestion;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import com.smoi.document.ChunkRepository;
import com.smoi.document.DocumentRepository;
import com.smoi.embedding.EmbeddingException;
import com.smoi.embedding.EmbeddingProperties;
import com.smoi.embedding.EmbeddingProvider;
import com.smoi.ingestion.chunking.ChunkDraft;
import com.smoi.ingestion.chunking.Chunker;
import com.smoi.ingestion.parsing.Block;
import com.smoi.ingestion.parsing.DocumentParseException;
import com.smoi.ingestion.parsing.DocumentParser;
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

    public IngestionPipeline(JobQueue queue, DocumentRepository documents, ChunkRepository chunks, DocumentParser parser,
                             Chunker chunker, EmbeddingProvider embeddings, IngestionProperties props,
                             EmbeddingProperties embeddingProps, TransactionTemplate tx) {
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
        try {
            if (job.attempts() > job.maxAttempts()) {
                // The previous worker claimed the final attempt and then stopped renewing its
                // lease (crash, kill, or hang). Don't start another attempt.
                fail(job, "Gave up after " + job.maxAttempts()
                        + " attempts: the worker stopped responding during the last attempt");
                return;
            }
            process(job);
        } catch (LeaseLostException e) {
            // Another worker owns the job now. Writing anything would race with it.
            log.warn("Abandoning job {}: {}", job.id(), e.getMessage());
        } catch (DocumentParseException e) {
            // The file itself is the problem, so retrying can't help.
            fail(job, e.getMessage());
        } catch (Exception e) {
            // Anything else (embedding provider down, database hiccup) may pass, so retry.
            retryOrFail(job, describe(e));
        }
    }

    private void process(IngestionJob job) {
        Optional<DocumentRepository.Content> content = tx.execute(status ->
                documents.startProcessing(job.userId(), job.documentId(), job.documentVersion()));
        if (content.isEmpty()) {
            queue.markCancelled(job, "The document was deleted or replaced before indexing started");
            return;
        }

        // Parse and clean, then chunk.
        List<Block> blocks = parser.parse(content.get().bytes(), content.get().mediaType());
        List<ChunkDraft> drafts = chunker.chunk(blocks);
        queue.renewLease(job);

        // Embed, in batches. Renewing the lease before each batch is the worker's heartbeat.
        List<float[]> vectors = new ArrayList<>(drafts.size());
        for (int from = 0; from < drafts.size(); from += batchSize) {
            queue.renewLease(job);
            List<String> texts = drafts.subList(from, Math.min(drafts.size(), from + batchSize))
                    .stream().map(ChunkDraft::text).toList();
            vectors.addAll(checked(embeddings.embedDocuments(texts), texts.size()));
        }

        // Store: one short transaction.
        tx.executeWithoutResult(status -> {
            // Lock order: document row, then job row. Replace and delete use the same order,
            // so they can't deadlock with this transaction.
            if (!documents.lockVersion(job.userId(), job.documentId(), job.documentVersion())) {
                queue.markCancelled(job, "The document was deleted or replaced during indexing");
                return;
            }
            if (!queue.markSucceeded(job)) {
                throw new LeaseLostException(job); // rolls the transaction back
            }
            chunks.deleteForDocument(job.userId(), job.documentId());
            chunks.insertAll(job.userId(), job.documentId(), drafts, vectors, embeddings.modelId());
            documents.markIndexed(job.userId(), job.documentId(), job.documentVersion(), drafts.size());
        });
        log.info("Indexed document {} version {}: {} chunks", job.documentId(), job.documentVersion(), drafts.size());
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

    private void retryOrFail(IngestionJob job, String error) {
        if (job.attempts() >= job.maxAttempts()) {
            fail(job, "Gave up after " + job.attempts() + " attempts. Last error: " + error);
            return;
        }
        tx.executeWithoutResult(status -> {
            documents.markQueued(job.userId(), job.documentId(), job.documentVersion());
            if (!queue.scheduleRetry(job, error, props.backoffAfter(job.attempts()))) {
                status.setRollbackOnly();
            }
        });
        log.warn("Job {} attempt {} failed, will retry: {}", job.id(), job.attempts(), error);
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
            }
        });
        log.warn("Job {} moved to dead-letter: {}", job.id(), error);
    }

    private static String describe(Exception e) {
        String message = e.getMessage();
        return message == null ? e.getClass().getSimpleName() : message;
    }
}
