package com.smoi.document;

import java.util.List;
import java.util.UUID;

import com.smoi.embedding.PgVector;
import com.smoi.ingestion.chunking.ChunkDraft;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * SQL for document_chunks. Every query filters by {@code user_id}. Chunks are derived data,
 * so they are hard-deleted when their document is deleted or re-indexed: a deleted
 * document's text must not stay in the database (NFR-04.04).
 */
@Repository
public class ChunkRepository {

    private final JdbcClient jdbc;
    private final JdbcTemplate jdbcTemplate;

    public ChunkRepository(JdbcClient jdbc, JdbcTemplate jdbcTemplate) {
        this.jdbc = jdbc;
        this.jdbcTemplate = jdbcTemplate;
    }

    public int deleteForDocument(UUID userId, UUID documentId) {
        return jdbc.sql("DELETE FROM document_chunks WHERE user_id = :userId AND document_id = :documentId")
                .param("userId", userId)
                .param("documentId", documentId)
                .update();
    }

    /** Inserts all chunks of a document in one JDBC batch. {@code embeddings.get(i)} belongs to {@code chunks.get(i)}. */
    public void insertAll(UUID userId, UUID documentId, List<ChunkDraft> chunks, List<float[]> embeddings, String model) {
        jdbcTemplate.batchUpdate("""
                        INSERT INTO document_chunks
                            (user_id, document_id, chunk_index, content, page_start, page_end, section,
                             token_count, embedding, embedding_model)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS vector), ?)
                        """,
                chunks, 200, (ps, chunk) -> {
                    ps.setObject(1, userId);
                    ps.setObject(2, documentId);
                    ps.setInt(3, chunk.index());
                    ps.setString(4, chunk.text());
                    ps.setObject(5, chunk.pageStart());
                    ps.setObject(6, chunk.pageEnd());
                    ps.setString(7, chunk.section());
                    ps.setInt(8, chunk.tokenCount());
                    ps.setString(9, PgVector.literal(embeddings.get(chunk.index())));
                    ps.setString(10, model);
                });
    }

    public List<Chunk> listForDocument(UUID userId, UUID documentId) {
        return jdbc.sql("""
                        SELECT id, document_id, chunk_index, content, page_start, page_end, section,
                               token_count, embedding_model
                          FROM document_chunks
                         WHERE user_id = :userId AND document_id = :documentId AND deleted_at IS NULL
                         ORDER BY chunk_index
                        """)
                .param("userId", userId)
                .param("documentId", documentId)
                .query(Chunk.class)
                .list();
    }

}
