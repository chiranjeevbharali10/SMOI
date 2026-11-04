package com.smoi.gmail;

import java.time.Instant;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** SQL for {@code emails}. Every query is scoped to the user and to rows that aren't deleted. */
@Repository
public class EmailRepository {

    public record Email(UUID id, UUID userId, String gmailId, String threadId, String fromAddress, String subject,
                        Instant receivedAt, String bodyText, String category, String summary, Instant announcedAt,
                        UUID documentId, UUID taskId, Instant createdAt) {
    }

    /** What an alert carries: no sender, subject or text, only enough to open the inbox (FR-05.04). */
    public record Alert(UUID id, Instant receivedAt) {
    }

    private static final String COLUMNS = """
            id, user_id, gmail_id, thread_id, from_address, subject, received_at, body_text, category, summary,
            announced_at, document_id, task_id, created_at""";

    private final JdbcClient jdbc;

    public EmailRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Stores a message once. A second sync of the same message (or two syncs at once) finds the
     * unique index and adds nothing.
     *
     * @param announced true to record it as already announced (the first sync's backlog)
     * @return whether it was new
     */
    public boolean insertIfNew(UUID userId, GmailClient.Message m, boolean announced) {
        return jdbc.sql("""
                        INSERT INTO emails (user_id, gmail_id, thread_id, from_address, subject, received_at, body_text, announced_at)
                        VALUES (:userId, :gmailId, :threadId, :from, :subject, :received, :body,
                                CASE WHEN CAST(:announced AS boolean) THEN now() END)
                        ON CONFLICT (user_id, gmail_id) WHERE deleted_at IS NULL DO NOTHING
                        """)
                .param("userId", userId).param("gmailId", m.id()).param("threadId", m.threadId())
                .param("from", m.from()).param("subject", m.subject())
                .param("received", java.sql.Timestamp.from(m.receivedAt())).param("body", m.bodyText())
                .param("announced", announced)
                .update() == 1;
    }

    public Set<String> knownGmailIds(UUID userId, Collection<String> gmailIds) {
        if (gmailIds.isEmpty()) {
            return Set.of();
        }
        return new HashSet<>(jdbc.sql("""
                        SELECT gmail_id FROM emails
                         WHERE user_id = :userId AND deleted_at IS NULL AND gmail_id IN (:ids)
                        """)
                .param("userId", userId).param("ids", gmailIds)
                .query(String.class).list());
    }

    public List<Email> unclassified(UUID userId, int limit) {
        return jdbc.sql("SELECT " + COLUMNS + """
                         FROM emails
                        WHERE user_id = :userId AND deleted_at IS NULL AND category IS NULL
                        ORDER BY received_at DESC LIMIT :limit
                        """)
                .param("userId", userId).param("limit", limit)
                .query(Email.class).list();
    }

    public void saveClassification(UUID userId, UUID id, String category, String summary) {
        jdbc.sql("UPDATE emails SET category = :c, summary = :s WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("c", category).param("s", summary).param("id", id).param("userId", userId)
                .update();
    }

    public List<Email> list(UUID userId, int limit) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM emails WHERE user_id = :userId AND deleted_at IS NULL"
                        + " ORDER BY received_at DESC LIMIT :limit")
                .param("userId", userId).param("limit", limit)
                .query(Email.class).list();
    }

    public Optional<Email> find(UUID userId, UUID id) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM emails WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", id).param("userId", userId)
                .query(Email.class).optional();
    }

    /**
     * Hands out each important email's alert exactly once. The same statement that returns it
     * records it as announced, so a restart, a second desktop or a repeated poll gets nothing.
     */
    public List<Alert> claimAlerts(UUID userId) {
        return jdbc.sql("""
                        UPDATE emails SET announced_at = now()
                         WHERE user_id = :userId AND deleted_at IS NULL AND announced_at IS NULL AND category = 'important'
                        RETURNING id, received_at
                        """)
                .param("userId", userId)
                .query(Alert.class).list();
    }

    /** Emails that are classified but not important don't alert; mark them so they never do. */
    public void settleNonAlerts(UUID userId) {
        jdbc.sql("""
                        UPDATE emails SET announced_at = now()
                         WHERE user_id = :userId AND deleted_at IS NULL AND announced_at IS NULL
                           AND category IS NOT NULL AND category <> 'important'
                        """)
                .param("userId", userId).update();
    }

    /** Links the task only if none is linked yet; returns the task now linked. */
    public UUID linkTask(UUID userId, UUID id, UUID taskId) {
        jdbc.sql("UPDATE emails SET task_id = :t WHERE id = :id AND user_id = :userId AND deleted_at IS NULL AND task_id IS NULL")
                .param("t", taskId).param("id", id).param("userId", userId).update();
        return find(userId, id).map(Email::taskId).orElse(null);
    }

    public void setDocument(UUID userId, UUID id, UUID documentId) {
        jdbc.sql("UPDATE emails SET document_id = :d WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("d", documentId).param("id", id).param("userId", userId).update();
    }

    /** Deletes the user's email data (disconnect). Returns the SMOI Brain documents made from emails. */
    public List<UUID> deleteAll(UUID userId) {
        return jdbc.sql("""
                        UPDATE emails SET deleted_at = now(), body_text = '', summary = '', subject = '', from_address = ''
                         WHERE user_id = :userId AND deleted_at IS NULL
                        RETURNING document_id
                        """)
                .param("userId", userId)
                .query((rs, n) -> (UUID) rs.getObject("document_id"))
                .list().stream().filter(java.util.Objects::nonNull).toList();
    }
}
