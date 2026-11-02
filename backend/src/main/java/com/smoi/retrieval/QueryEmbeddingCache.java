package com.smoi.retrieval;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;

import com.smoi.embedding.PgVector;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Exact-match cache of query embeddings, per user, in Postgres.
 *
 * <p>Load tests showed embedding the query is the bottleneck: about 0.7 s of a 0.7 s p95 search
 * on this CPU-only machine, while both SQL searches take 2 to 3 ms (docs/performance.md). Looking a
 * vector up by a hash takes about a millisecond. "Exact match" means the same text after trimming,
 * lower-casing and collapsing whitespace; a reworded question is a miss.
 *
 * <p>Why Postgres and not memory: every backend instance shares it (NFR-06.01), and the rows follow
 * the same rules as other user data (scoped by user, soft-deletable). Entries expire after
 * {@code smoi.retrieval.query-cache.ttl}.
 */
@Component
public class QueryEmbeddingCache {

    private final JdbcClient jdbc;
    private final boolean enabled;
    private final Duration ttl;
    private final Counter hits;
    private final Counter misses;

    public QueryEmbeddingCache(JdbcClient jdbc, MeterRegistry meters,
                               @Value("${smoi.retrieval.query-cache.enabled:true}") boolean enabled,
                               @Value("${smoi.retrieval.query-cache.ttl:P1D}") Duration ttl) {
        this.jdbc = jdbc;
        this.enabled = enabled;
        this.ttl = ttl;
        this.hits = Counter.builder("smoi.query.embedding.cache").tag("result", "hit").register(meters);
        this.misses = Counter.builder("smoi.query.embedding.cache").tag("result", "miss").register(meters);
    }

    /** The cached vector for this user's query, or {@code compute}'s result (then stored). */
    public float[] get(UUID userId, String model, String query, Supplier<float[]> compute) {
        if (!enabled) {
            return compute.get();
        }
        String key = sha256(normalize(query));
        Optional<String> cached = jdbc.sql("""
                        SELECT embedding::text FROM query_embedding_cache
                         WHERE user_id = :userId AND embedding_model = :model AND query_sha256 = :key
                           AND deleted_at IS NULL
                           AND created_at > now() - :ttlSeconds * interval '1 second'
                        """)
                .param("userId", userId).param("model", model).param("key", key)
                .param("ttlSeconds", ttl.toSeconds())
                .query(String.class).optional();
        if (cached.isPresent()) {
            hits.increment();
            return PgVector.parse(cached.get());
        }
        misses.increment();
        float[] vector = compute.get();
        // Replace an expired entry if there is one; then drop this user's other expired entries.
        jdbc.sql("""
                        INSERT INTO query_embedding_cache (user_id, embedding_model, query_sha256, embedding)
                        VALUES (:userId, :model, :key, CAST(:embedding AS vector))
                        ON CONFLICT (user_id, embedding_model, query_sha256) WHERE deleted_at IS NULL
                        DO UPDATE SET embedding = EXCLUDED.embedding, created_at = now()
                        """)
                .param("userId", userId).param("model", model).param("key", key)
                .param("embedding", PgVector.literal(vector))
                .update();
        jdbc.sql("""
                        DELETE FROM query_embedding_cache
                         WHERE user_id = :userId AND created_at < now() - :ttlSeconds * interval '1 second'
                        """)
                .param("userId", userId).param("ttlSeconds", ttl.toSeconds())
                .update();
        return vector;
    }

    static String normalize(String query) {
        return query.strip().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    private static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
