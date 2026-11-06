package com.smoi.folder;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * SQL for {@code folders} and {@code folder_files}. Every query filters by {@code user_id} and
 * {@code deleted_at IS NULL}.
 */
@Repository
public class FolderRepository {

    private static final String FOLDER_COLUMNS = "id, user_id, path, created_at";
    private static final String FILE_COLUMNS = """
            id, user_id, folder_id, path, content_hash, modified_time, size_bytes, status, error, document_id, updated_at""";

    private final JdbcClient jdbc;

    public FolderRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    // ---------- folders ----------

    /** Throws DuplicateKeyException if the user already watches this path. */
    public Folder insertFolder(UUID userId, String path) {
        return jdbc.sql("INSERT INTO folders (user_id, path) VALUES (:userId, :path) RETURNING " + FOLDER_COLUMNS)
                .param("userId", userId)
                .param("path", path)
                .query(Folder.class)
                .single();
    }

    public List<Folder> listFolders(UUID userId) {
        return jdbc.sql("SELECT " + FOLDER_COLUMNS
                        + " FROM folders WHERE user_id = :userId AND deleted_at IS NULL ORDER BY path")
                .param("userId", userId)
                .query(Folder.class)
                .list();
    }

    public Optional<Folder> findFolder(UUID userId, UUID id) {
        return jdbc.sql("SELECT " + FOLDER_COLUMNS
                        + " FROM folders WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", id)
                .param("userId", userId)
                .query(Folder.class)
                .optional();
    }

    public void softDeleteFolder(UUID userId, UUID id) {
        jdbc.sql("UPDATE folders SET deleted_at = now() WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", id)
                .param("userId", userId)
                .update();
    }

    // ---------- files ----------

    public Optional<FolderFile> findFile(UUID userId, String path) {
        return jdbc.sql("SELECT " + FILE_COLUMNS
                        + " FROM folder_files WHERE user_id = :userId AND path = :path AND deleted_at IS NULL")
                .param("userId", userId)
                .param("path", path)
                .query(FolderFile.class)
                .optional();
    }

    public List<FolderFile> listFiles(UUID userId, UUID folderId) {
        return jdbc.sql("""
                        SELECT %s FROM folder_files
                         WHERE user_id = :userId AND folder_id = :folderId AND deleted_at IS NULL
                         ORDER BY path
                        """.formatted(FILE_COLUMNS))
                .param("userId", userId)
                .param("folderId", folderId)
                .query(FolderFile.class)
                .list();
    }

    /** Creates the file's row, or overwrites the active row at the same path. */
    public FolderFile upsertFile(UUID userId, UUID folderId, String path, String contentHash, Instant modifiedTime,
                                 long sizeBytes, String status, String error, UUID documentId) {
        return jdbc.sql("""
                        INSERT INTO folder_files (user_id, folder_id, path, content_hash, modified_time, size_bytes,
                                                  status, error, document_id)
                        VALUES (:userId, :folderId, :path, :hash, :mtime, :size, :status, :error, :documentId)
                        ON CONFLICT (user_id, path) WHERE deleted_at IS NULL DO UPDATE
                           SET folder_id = EXCLUDED.folder_id, content_hash = EXCLUDED.content_hash,
                               modified_time = EXCLUDED.modified_time, size_bytes = EXCLUDED.size_bytes,
                               status = EXCLUDED.status, error = EXCLUDED.error, document_id = EXCLUDED.document_id
                        RETURNING %s
                        """.formatted(FILE_COLUMNS))
                .param("userId", userId)
                .param("folderId", folderId)
                .param("path", path)
                .param("hash", contentHash)
                .param("mtime", Timestamp.from(modifiedTime))
                .param("size", sizeBytes)
                .param("status", status)
                .param("error", error)
                .param("documentId", documentId)
                .query(FolderFile.class)
                .single();
    }

    /** Records a new modified time and size for a file whose content did not change. */
    public FolderFile touchFile(UUID userId, UUID id, Instant modifiedTime, long sizeBytes) {
        return jdbc.sql("""
                        UPDATE folder_files SET modified_time = :mtime, size_bytes = :size
                         WHERE id = :id AND user_id = :userId AND deleted_at IS NULL
                        RETURNING %s
                        """.formatted(FILE_COLUMNS))
                .param("mtime", Timestamp.from(modifiedTime))
                .param("size", sizeBytes)
                .param("id", id)
                .param("userId", userId)
                .query(FolderFile.class)
                .single();
    }

    public FolderFile moveFile(UUID userId, UUID id, UUID folderId, String path) {
        return jdbc.sql("""
                        UPDATE folder_files SET folder_id = :folderId, path = :path
                         WHERE id = :id AND user_id = :userId AND deleted_at IS NULL
                        RETURNING %s
                        """.formatted(FILE_COLUMNS))
                .param("folderId", folderId)
                .param("path", path)
                .param("id", id)
                .param("userId", userId)
                .query(FolderFile.class)
                .single();
    }

    public void softDeleteFile(UUID userId, UUID id) {
        jdbc.sql("UPDATE folder_files SET deleted_at = now() WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", id)
                .param("userId", userId)
                .update();
    }

    /** How many active files point at this document. */
    public int countFilesForDocument(UUID userId, UUID documentId) {
        return jdbc.sql("""
                        SELECT count(*) FROM folder_files
                         WHERE user_id = :userId AND document_id = :documentId AND deleted_at IS NULL
                        """)
                .param("userId", userId)
                .param("documentId", documentId)
                .query(Integer.class)
                .single();
    }

    /** Called by the ingestion worker when a document's indexing ends, inside its final transaction. */
    public void setStatusForDocument(UUID userId, UUID documentId, String status, String error) {
        jdbc.sql("""
                        UPDATE folder_files SET status = :status, error = :error
                         WHERE user_id = :userId AND document_id = :documentId AND deleted_at IS NULL
                        """)
                .param("status", status)
                .param("error", error)
                .param("userId", userId)
                .param("documentId", documentId)
                .update();
    }

    /** Active file counts per folder and status: folder id to (status to count). */
    public Map<UUID, Map<String, Integer>> countsByFolder(UUID userId) {
        Map<UUID, Map<String, Integer>> out = new HashMap<>();
        jdbc.sql("""
                        SELECT folder_id, status, count(*) AS n FROM folder_files
                         WHERE user_id = :userId AND deleted_at IS NULL
                         GROUP BY folder_id, status
                        """)
                .param("userId", userId)
                .query((rs, i) -> {
                    out.computeIfAbsent(rs.getObject("folder_id", UUID.class), k -> new HashMap<>())
                            .put(rs.getString("status"), rs.getInt("n"));
                    return i;
                })
                .list();
        return out;
    }
}
