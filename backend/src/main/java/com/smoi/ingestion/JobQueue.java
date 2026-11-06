package com.smoi.ingestion;

import java.time.Duration;
import java.util.Optional;
import java.util.UUID;

import com.smoi.observability.RequestIds;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * The ingestion job queue, stored in the {@code ingestion_jobs} table. See
 * docs/adr/0005-postgres-job-queue.md for why this is Postgres and not a message broker.
 *
 * <p>Every method that changes a claimed job checks its {@code lease_token} and
 * {@code status = 'running'}. If another worker has taken the job over, or it was cancelled,
 * the update matches no row and the caller learns it no longer owns the job.
 */
@Repository
public class JobQueue {

    private static final int MAX_ERROR_LENGTH = 2000;

    private final JdbcClient jdbc;
    private final IngestionProperties props;

    public JobQueue(JdbcClient jdbc, IngestionProperties props) {
        this.jdbc = jdbc;
        this.props = props;
    }

    /** Uploads by hand: claimed before {@link #BACKGROUND} jobs. */
    public static final int INTERACTIVE = 0;
    /** Folder sync: indexed in the background, after anything the user is waiting for. */
    public static final int BACKGROUND = 10;

    /** Adds a job for one version of a document. Call inside the transaction that wrote the document. */
    public void enqueue(UUID userId, UUID documentId, int documentVersion) {
        enqueue(userId, documentId, documentVersion, INTERACTIVE);
    }

    /** As {@link #enqueue(UUID, UUID, int)}, with a priority: lower numbers are claimed first. */
    public void enqueue(UUID userId, UUID documentId, int documentVersion, int priority) {
        jdbc.sql("""
                        INSERT INTO ingestion_jobs (user_id, document_id, document_version, max_attempts, request_id, priority)
                        VALUES (:userId, :documentId, :version, :maxAttempts, :requestId, :priority)
                        """)
                .param("priority", priority)
                .param("requestId", RequestIds.current())
                .param("userId", userId)
                .param("documentId", documentId)
                .param("version", documentVersion)
                .param("maxAttempts", props.maxAttempts())
                .update();
    }

    /**
     * Claims the oldest job of the highest priority (lowest number) that is ready to run: a queued job whose retry time has come, or a
     * running job whose lease has expired because its worker died.
     *
     * <p>{@code FOR UPDATE SKIP LOCKED} is what makes several workers safe: the inner SELECT
     * locks the row it picks, and other workers running the same query at the same moment skip
     * locked rows instead of waiting for them or taking the same one. The outer UPDATE then
     * marks the job as running and sets a new lease in the same statement.
     *
     * <p>This is the one deliberate query on a user-owned table without a {@code user_id}
     * filter: a worker can't know whose job is next until it has claimed it. It returns only
     * ids, and everything the worker does afterwards is scoped to the job's {@code user_id}.
     * See docs/adr/0005-postgres-job-queue.md.
     */
    public Optional<IngestionJob> claim() {
        return jdbc.sql("""
                        UPDATE ingestion_jobs
                           SET status = 'running',
                               attempts = attempts + 1,
                               lease_token = gen_random_uuid(),
                               available_at = now() + :leaseMillis * interval '1 millisecond'
                         WHERE id = (
                                 SELECT id FROM ingestion_jobs
                                  WHERE status IN ('queued', 'running')
                                    AND available_at <= now()
                                    AND deleted_at IS NULL
                                  ORDER BY priority, available_at
                                  LIMIT 1
                                    FOR UPDATE SKIP LOCKED)
                        RETURNING id, user_id, document_id, document_version, attempts, max_attempts, lease_token, request_id
                        """)
                .param("leaseMillis", props.lease().toMillis())
                .query(IngestionJob.class)
                .optional();
    }

    /** Counts for the queue gauges; see {@link #depth()}. */
    public record Depth(long ready, long backingOff, long running, double oldestReadySeconds) {
    }

    /**
     * How much work is waiting, for the metrics in {@link IngestionMetrics}.
     *
     * <p>The second deliberate query on a user-owned table without a {@code user_id} filter
     * (approved; see CLAUDE.md and docs/adr/0011). It is a read-only aggregate: it returns four
     * numbers and no rows, ids or user data, so nothing about any user can leak through it.
     */
    public Depth depth() {
        return jdbc.sql("""
                        SELECT count(*) FILTER (WHERE status = 'queued' AND available_at <= now())  AS ready,
                               count(*) FILTER (WHERE status = 'queued' AND available_at > now())   AS backing_off,
                               count(*) FILTER (WHERE status = 'running')                          AS running,
                               coalesce(extract(epoch FROM now() - min(available_at)
                                        FILTER (WHERE status = 'queued' AND available_at <= now())), 0) AS oldest
                          FROM ingestion_jobs
                         WHERE status IN ('queued', 'running')
                           AND deleted_at IS NULL
                        """)
                .query((rs, n) -> new Depth(rs.getLong("ready"), rs.getLong("backing_off"), rs.getLong("running"),
                        rs.getDouble("oldest")))
                .single();
    }

    /**
     * Extends the lease: the worker's "still alive" signal, sent between pipeline steps.
     *
     * @throws LeaseLostException if the job now belongs to another worker or was cancelled
     */
    public void renewLease(IngestionJob job) {
        int updated = jdbc.sql("""
                        UPDATE ingestion_jobs
                           SET available_at = now() + :leaseMillis * interval '1 millisecond'
                         WHERE id = :id AND user_id = :userId AND lease_token = :token
                           AND status = 'running' AND deleted_at IS NULL
                        """)
                .param("leaseMillis", props.lease().toMillis())
                .param("id", job.id())
                .param("userId", job.userId())
                .param("token", job.leaseToken())
                .update();
        if (updated == 0) {
            throw new LeaseLostException(job);
        }
    }

    /** Returns false if the worker no longer owns the job. */
    public boolean markSucceeded(IngestionJob job) {
        return finish(job, "succeeded", null);
    }

    /** The dead-letter state: no more retries, and {@code last_error} keeps the reason. */
    public boolean markDead(IngestionJob job, String error) {
        return finish(job, "dead", error);
    }

    /** The document was deleted or replaced while the job was running. */
    public boolean markCancelled(IngestionJob job, String reason) {
        return finish(job, "cancelled", reason);
    }

    /** Puts the job back in the queue, claimable again after {@code delay}. */
    public boolean scheduleRetry(IngestionJob job, String error, Duration delay) {
        return jdbc.sql("""
                        UPDATE ingestion_jobs
                           SET status = 'queued', lease_token = NULL, last_error = :error,
                               available_at = now() + :delayMillis * interval '1 millisecond'
                         WHERE id = :id AND user_id = :userId AND lease_token = :token
                           AND status = 'running' AND deleted_at IS NULL
                        """)
                .param("error", truncate(error))
                .param("delayMillis", delay.toMillis())
                .param("id", job.id())
                .param("userId", job.userId())
                .param("token", job.leaseToken())
                .update() == 1;
    }

    /** Cancels every unfinished job for a document. Used when it is replaced or deleted. */
    public void cancelUnfinished(UUID userId, UUID documentId, String reason) {
        jdbc.sql("""
                        UPDATE ingestion_jobs
                           SET status = 'cancelled', lease_token = NULL, last_error = :reason
                         WHERE user_id = :userId AND document_id = :documentId
                           AND status IN ('queued', 'running') AND deleted_at IS NULL
                        """)
                .param("reason", reason)
                .param("userId", userId)
                .param("documentId", documentId)
                .update();
    }

    private boolean finish(IngestionJob job, String status, String error) {
        return jdbc.sql("""
                        UPDATE ingestion_jobs
                           SET status = :status, lease_token = NULL, last_error = :error
                         WHERE id = :id AND user_id = :userId AND lease_token = :token
                           AND status = 'running' AND deleted_at IS NULL
                        """)
                .param("status", status)
                .param("error", truncate(error))
                .param("id", job.id())
                .param("userId", job.userId())
                .param("token", job.leaseToken())
                .update() == 1;
    }

    static String truncate(String error) {
        if (error == null || error.length() <= MAX_ERROR_LENGTH) {
            return error;
        }
        return error.substring(0, MAX_ERROR_LENGTH - 3) + "...";
    }
}
