package com.smoi.retrieval;

import java.util.Comparator;
import java.util.List;
import java.util.UUID;

import com.smoi.embedding.PgVector;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * The two first-stage searches, as plain SQL. Both are scoped to one user and to live
 * documents, and both can be restricted to documents the user allowed to go to a hosted LLM.
 */
@Repository
public class RetrievalRepository {

    private static final String SELECT_CHUNK = """
            SELECT c.id AS chunk_id, c.document_id, d.filename, c.chunk_index, c.content,
                   c.page_start, c.page_end, c.section""";

    private final JdbcClient jdbc;

    public RetrievalRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Full-text search. {@code plainto_tsquery} turns the question into stemmed words without
     * stop words ("What time does the garden open?" becomes 'time' & 'garden' & 'open'). It
     * joins them with AND, which would drop every chunk missing any one word, so we switch
     * the operator to OR. {@code ts_rank_cd} then ranks chunks higher when they match more of
     * the words, and when the matches are closer together.
     */
    public List<RetrievedChunk> keyword(UUID userId, String query, int limit, boolean hostedOnly) {
        return jdbc.sql(SELECT_CHUNK + """
                        ,
                               ts_rank_cd(c.content_tsv, q.query) AS score
                          FROM document_chunks c
                          JOIN documents d ON d.id = c.document_id AND d.user_id = c.user_id
                          CROSS JOIN (SELECT replace(plainto_tsquery('english', :query)::text, '&', '|')::tsquery AS query) q
                         WHERE c.user_id = :userId
                           AND c.deleted_at IS NULL AND d.deleted_at IS NULL
                           AND (NOT :hostedOnly OR d.hosted_llm_allowed)
                           AND c.content_tsv @@ q.query
                         ORDER BY score DESC, c.id
                         LIMIT :limit
                        """)
                .param("userId", userId)
                .param("query", query)
                .param("hostedOnly", hostedOnly)
                .param("limit", limit)
                .query((rs, i) -> new RetrievedChunk(
                        rs.getObject("chunk_id", UUID.class), rs.getObject("document_id", UUID.class),
                        rs.getString("filename"), rs.getInt("chunk_index"), rs.getString("content"),
                        (Integer) rs.getObject("page_start"), (Integer) rs.getObject("page_end"),
                        rs.getString("section"), rs.getDouble("score"), null, null))
                .list();
    }

    /**
     * Nearest neighbours by cosine distance ({@code <=>}), using the HNSW index.
     *
     * <p>An approximate index visits a limited number of candidates ({@code hnsw.ef_search},
     * 40 by default) and filters afterwards. With a {@code WHERE user_id = ...} filter, most
     * candidates can belong to other users, and the query would return fewer rows than asked
     * for. pgvector 0.8's iterative scan keeps searching the index until enough rows pass the
     * filter. {@code relaxed_order} may return rows slightly out of order, so they are sorted
     * again here. {@code SET LOCAL} only lasts until the end of this transaction.
     *
     * <p>Only vectors from the current embedding model are compared: vectors from different
     * models live in different spaces.
     */
    @Transactional(readOnly = true)
    public List<RetrievedChunk> vector(UUID userId, float[] queryVector, String embeddingModel, int limit,
                                       boolean hostedOnly) {
        jdbc.sql("SET LOCAL hnsw.iterative_scan = relaxed_order").update();
        List<RetrievedChunk> rows = jdbc.sql(SELECT_CHUNK + """
                        ,
                               1 - (c.embedding <=> CAST(:vector AS vector)) AS score
                          FROM document_chunks c
                          JOIN documents d ON d.id = c.document_id AND d.user_id = c.user_id
                         WHERE c.user_id = :userId
                           AND c.deleted_at IS NULL AND d.deleted_at IS NULL
                           AND (NOT :hostedOnly OR d.hosted_llm_allowed)
                           AND c.embedding_model = :model
                         ORDER BY c.embedding <=> CAST(:vector AS vector)
                         LIMIT :limit
                        """)
                .param("userId", userId)
                .param("vector", PgVector.literal(queryVector))
                .param("model", embeddingModel)
                .param("hostedOnly", hostedOnly)
                .param("limit", limit)
                .query((rs, i) -> new RetrievedChunk(
                        rs.getObject("chunk_id", UUID.class), rs.getObject("document_id", UUID.class),
                        rs.getString("filename"), rs.getInt("chunk_index"), rs.getString("content"),
                        (Integer) rs.getObject("page_start"), (Integer) rs.getObject("page_end"),
                        rs.getString("section"), rs.getDouble("score"), null, null))
                .list();
        return rows.stream().sorted(Comparator.comparingDouble(RetrievedChunk::score).reversed()).toList();
    }

}
