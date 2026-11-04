package com.smoi.actions;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** SQL for {@code google_actions}: proposed changes waiting for, or done after, the user's confirmation. */
@Repository
public class GoogleActionRepository {

    public record Action(UUID id, UUID userId, String kind, String payload, String status, String result,
                         Instant expiresAt, Instant appliedAt, Instant createdAt) {
    }

    /** What {@link #claim} found: the action, and the status it had before this claim. */
    public record Claim(Action action, String previousStatus) {
    }

    private static final String COLUMNS = "id, user_id, kind, payload::text AS payload, status, result::text AS result, expires_at, applied_at, created_at";

    private final JdbcClient jdbc;

    public GoogleActionRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Action insert(UUID userId, String kind, String payloadJson, Instant expiresAt) {
        return jdbc.sql("""
                        INSERT INTO google_actions (user_id, kind, payload, expires_at)
                        VALUES (:userId, :kind, CAST(:payload AS jsonb), :expires)
                        RETURNING %s
                        """.formatted(COLUMNS))
                .param("userId", userId).param("kind", kind).param("payload", payloadJson)
                .param("expires", java.sql.Timestamp.from(expiresAt))
                .query(Action.class).single();
    }

    public Optional<Action> find(UUID userId, UUID id) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM google_actions WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", id).param("userId", userId)
                .query(Action.class).optional();
    }

    /**
     * Takes the action for applying, in one statement, so two confirms can't both apply it:
     * <ul>
     *   <li>a proposed action that hasn't expired;</li>
     *   <li>or one left in {@code applying} for over a minute (the earlier attempt crashed or timed
     *       out), which the caller finishes carefully.</li>
     * </ul>
     * Empty if neither: already applied, failed, expired, being applied right now, or not this user's.
     */
    public Optional<Claim> claim(UUID userId, UUID id) {
        return jdbc.sql("""
                        WITH before AS (
                            SELECT id, status FROM google_actions
                             WHERE id = :id AND user_id = :userId AND deleted_at IS NULL
                             FOR UPDATE
                        )
                        UPDATE google_actions a SET status = 'applying'
                          FROM before
                         WHERE a.id = before.id
                           AND ((a.status = 'proposed' AND a.expires_at > now())
                                OR (a.status = 'applying' AND a.updated_at < now() - interval '1 minute'))
                        RETURNING a.id, a.user_id, a.kind, a.payload::text AS payload, a.status, a.result::text AS result,
                                  a.expires_at, a.applied_at, a.created_at, before.status AS previous_status
                        """)
                .param("id", id).param("userId", userId)
                .query((rs, n) -> new Claim(new Action(rs.getObject("id", UUID.class), rs.getObject("user_id", UUID.class),
                        rs.getString("kind"), rs.getString("payload"), rs.getString("status"), rs.getString("result"),
                        rs.getTimestamp("expires_at").toInstant(), null, rs.getTimestamp("created_at").toInstant()),
                        rs.getString("previous_status")))
                .optional();
    }

    public void applied(UUID userId, UUID id, String resultJson) {
        jdbc.sql("""
                        UPDATE google_actions SET status = 'applied', result = CAST(:result AS jsonb), applied_at = now()
                         WHERE id = :id AND user_id = :userId AND deleted_at IS NULL
                        """)
                .param("result", resultJson).param("id", id).param("userId", userId).update();
    }

    /** Back to proposed after a failure Google reported, so the user can try again. */
    public void release(UUID userId, UUID id) {
        jdbc.sql("UPDATE google_actions SET status = 'proposed' WHERE id = :id AND user_id = :userId AND status = 'applying'")
                .param("id", id).param("userId", userId).update();
    }

    public void failed(UUID userId, UUID id, String resultJson) {
        jdbc.sql("""
                        UPDATE google_actions SET status = 'failed', result = CAST(:result AS jsonb)
                         WHERE id = :id AND user_id = :userId AND deleted_at IS NULL
                        """)
                .param("result", resultJson).param("id", id).param("userId", userId).update();
    }

    public void deletePending(UUID userId) {
        jdbc.sql("UPDATE google_actions SET deleted_at = now() WHERE user_id = :userId AND deleted_at IS NULL AND status = 'proposed'")
                .param("userId", userId).update();
    }
}
