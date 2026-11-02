package com.smoi.document;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * SQL for the documents table. Every query filters by {@code user_id} and
 * {@code deleted_at IS NULL}. Methods that take a {@code version} only act on that version, so
 * an ingestion job for an older version of the file changes nothing.
 */
@Repository
public class DocumentRepository {

    private static final String COLUMNS = """
            id, user_id, filename, media_type, size_bytes, content_sha256, version, status, error,
            chunk_count, created_at, updated_at, indexed_at, hosted_llm_allowed""";

    private final JdbcClient jdbc;

    public DocumentRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Inserts a document unless the user already has an active one with the same content.
     * Returns empty in that case. Relies on the partial unique index, so it is safe under
     * concurrent uploads of the same file.
     */
    public Optional<Document> insertIfNew(UUID userId, String filename, String mediaType, String sha256, byte[] content) {
        return jdbc.sql("""
                        INSERT INTO documents (user_id, filename, media_type, size_bytes, content_sha256, content)
                        VALUES (:userId, :filename, :mediaType, :size, :sha256, :content)
                        ON CONFLICT (user_id, content_sha256) WHERE deleted_at IS NULL DO NOTHING
                        RETURNING %s
                        """.formatted(COLUMNS))
                .param("userId", userId)
                .param("filename", filename)
                .param("mediaType", mediaType)
                .param("size", (long) content.length)
                .param("sha256", sha256)
                .param("content", content)
                .query(Document.class)
                .optional();
    }

    public Optional<Document> findActive(UUID userId, UUID id) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM documents WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", id)
                .param("userId", userId)
                .query(Document.class)
                .optional();
    }

    public Optional<Document> findActiveBySha256(UUID userId, String sha256) {
        return jdbc.sql("""
                        SELECT %s FROM documents
                         WHERE user_id = :userId AND content_sha256 = :sha256 AND deleted_at IS NULL
                        """.formatted(COLUMNS))
                .param("userId", userId)
                .param("sha256", sha256)
                .query(Document.class)
                .optional();
    }

    public List<Document> listActive(UUID userId) {
        return jdbc.sql("""
                        SELECT %s FROM documents
                         WHERE user_id = :userId AND deleted_at IS NULL
                         ORDER BY created_at DESC, id
                        """.formatted(COLUMNS))
                .param("userId", userId)
                .query(Document.class)
                .list();
    }

    /** Locks the document row until the transaction ends. Serialises replace, delete and the worker's final write. */
    public Optional<Document> lockActive(UUID userId, UUID id) {
        return jdbc.sql("SELECT " + COLUMNS
                        + " FROM documents WHERE id = :id AND user_id = :userId AND deleted_at IS NULL FOR UPDATE")
                .param("id", id)
                .param("userId", userId)
                .query(Document.class)
                .optional();
    }

    /** Stores a new file for an existing document and starts a new version. Throws DuplicateKeyException
     *  if another active document of the user already has this content. */
    public Document replaceContent(UUID userId, UUID id, String filename, String mediaType, String sha256, byte[] content) {
        return jdbc.sql("""
                        UPDATE documents
                           SET filename = :filename, media_type = :mediaType, size_bytes = :size,
                               content_sha256 = :sha256, content = :content, version = version + 1,
                               status = 'queued', error = NULL
                         WHERE id = :id AND user_id = :userId AND deleted_at IS NULL
                        RETURNING %s
                        """.formatted(COLUMNS))
                .param("id", id)
                .param("userId", userId)
                .param("filename", filename)
                .param("mediaType", mediaType)
                .param("size", (long) content.length)
                .param("sha256", sha256)
                .param("content", content)
                .query(Document.class)
                .single();
    }

    /** Sets whether this document's text may be sent to a hosted LLM. Empty if there is no such document. */
    public Optional<Document> setHostedLlmAllowed(UUID userId, UUID id, boolean allowed) {
        return jdbc.sql("""
                        UPDATE documents SET hosted_llm_allowed = :allowed
                         WHERE id = :id AND user_id = :userId AND deleted_at IS NULL
                        RETURNING %s
                        """.formatted(COLUMNS))
                .param("allowed", allowed)
                .param("id", id)
                .param("userId", userId)
                .query(Document.class)
                .optional();
    }

    /** How many of the user's documents may not be sent to a hosted LLM. */
    public int countNotAllowedForHostedLlm(UUID userId) {
        return jdbc.sql("""
                        SELECT count(*) FROM documents
                         WHERE user_id = :userId AND deleted_at IS NULL AND NOT hosted_llm_allowed
                        """)
                .param("userId", userId)
                .query(Integer.class)
                .single();
    }

    /** Soft-deletes the document and drops the file bytes. Returns false if there was nothing to delete. */
    public boolean softDelete(UUID userId, UUID id) {
        return jdbc.sql("""
                        UPDATE documents SET deleted_at = now(), content = NULL
                         WHERE id = :id AND user_id = :userId AND deleted_at IS NULL
                        """)
                .param("id", id)
                .param("userId", userId)
                .update() == 1;
    }

    // ---- used by the ingestion worker ------------------------------------------------------

    public record Content(byte[] bytes, String mediaType) {
    }

    /** Marks a version as being processed and returns its file, or empty if that version is gone. */
    public Optional<Content> startProcessing(UUID userId, UUID id, int version) {
        return jdbc.sql("""
                        UPDATE documents SET status = 'processing'
                         WHERE id = :id AND user_id = :userId AND version = :version AND deleted_at IS NULL
                        RETURNING content AS bytes, media_type
                        """)
                .param("id", id)
                .param("userId", userId)
                .param("version", version)
                .query(Content.class)
                .optional();
    }

    /** Locks a specific version of the document. Empty if it was deleted or replaced. */
    public boolean lockVersion(UUID userId, UUID id, int version) {
        return jdbc.sql("""
                        SELECT id FROM documents
                         WHERE id = :id AND user_id = :userId AND version = :version AND deleted_at IS NULL
                           FOR UPDATE
                        """)
                .param("id", id)
                .param("userId", userId)
                .param("version", version)
                .query(UUID.class)
                .optional()
                .isPresent();
    }

    public void markIndexed(UUID userId, UUID id, int version, int chunkCount) {
        jdbc.sql("""
                        UPDATE documents
                           SET status = 'indexed', error = NULL, chunk_count = :chunkCount, indexed_at = now()
                         WHERE id = :id AND user_id = :userId AND version = :version AND deleted_at IS NULL
                        """)
                .param("id", id)
                .param("userId", userId)
                .param("version", version)
                .param("chunkCount", chunkCount)
                .update();
    }

    /** Back to queued while a retry is pending. */
    public void markQueued(UUID userId, UUID id, int version) {
        jdbc.sql("""
                        UPDATE documents SET status = 'queued'
                         WHERE id = :id AND user_id = :userId AND version = :version AND deleted_at IS NULL
                        """)
                .param("id", id)
                .param("userId", userId)
                .param("version", version)
                .update();
    }

    /** Returns true if this version was still current and is now marked failed. */
    public boolean markFailed(UUID userId, UUID id, int version, String error) {
        return jdbc.sql("""
                        UPDATE documents SET status = 'failed', error = :error, chunk_count = 0, indexed_at = NULL
                         WHERE id = :id AND user_id = :userId AND version = :version AND deleted_at IS NULL
                        """)
                .param("id", id)
                .param("userId", userId)
                .param("version", version)
                .param("error", error)
                .update() == 1;
    }
}
