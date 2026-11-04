package com.smoi.gmail;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * SQL for {@code gmail_drafts}: the drafts SMOI created. SMOI only updates drafts listed here
 * (FR-05.09), and every query is scoped to the user.
 */
@Repository
public class DraftRepository {

    public record Draft(UUID id, UUID userId, String gmailDraftId, String gmailMessageId, String toAddress,
                        String subject, String body, Instant goneAt, Instant createdAt, Instant updatedAt) {
    }

    private static final String COLUMNS = """
            id, user_id, gmail_draft_id, gmail_message_id, to_address, subject, body, gone_at, created_at, updated_at""";

    private final JdbcClient jdbc;

    public DraftRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Draft insert(UUID userId, GmailClient.DraftRef ref, DraftMessage m) {
        return jdbc.sql("""
                        INSERT INTO gmail_drafts (user_id, gmail_draft_id, gmail_message_id, to_address, subject, body)
                        VALUES (:userId, :draftId, :messageId, :to, :subject, :body)
                        RETURNING %s
                        """.formatted(COLUMNS))
                .param("userId", userId).param("draftId", ref.draftId()).param("messageId", ref.messageId())
                .param("to", m.to()).param("subject", m.subject()).param("body", m.body())
                .query(Draft.class).single();
    }

    public Draft update(UUID userId, UUID id, GmailClient.DraftRef ref, DraftMessage m) {
        return jdbc.sql("""
                        UPDATE gmail_drafts SET gmail_draft_id = :draftId, gmail_message_id = :messageId, to_address = :to,
                               subject = :subject, body = :body
                         WHERE id = :id AND user_id = :userId AND deleted_at IS NULL
                        RETURNING %s
                        """.formatted(COLUMNS))
                .param("draftId", ref.draftId()).param("messageId", ref.messageId())
                .param("to", m.to()).param("subject", m.subject()).param("body", m.body())
                .param("id", id).param("userId", userId)
                .query(Draft.class).single();
    }

    public Optional<Draft> find(UUID userId, UUID id) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM gmail_drafts WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", id).param("userId", userId)
                .query(Draft.class).optional();
    }

    public List<Draft> list(UUID userId) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM gmail_drafts WHERE user_id = :userId AND deleted_at IS NULL"
                        + " ORDER BY created_at DESC LIMIT 100")
                .param("userId", userId)
                .query(Draft.class).list();
    }

    /** Gmail says it's gone: the user sent or deleted it there. */
    public void markGone(UUID userId, UUID id) {
        jdbc.sql("UPDATE gmail_drafts SET gone_at = now() WHERE id = :id AND user_id = :userId AND deleted_at IS NULL AND gone_at IS NULL")
                .param("id", id).param("userId", userId).update();
    }

    /** Disconnect with data deletion. The drafts stay in Gmail; SMOI only forgets them. */
    public void deleteAll(UUID userId) {
        jdbc.sql("UPDATE gmail_drafts SET deleted_at = now(), body = '', subject = '' WHERE user_id = :userId AND deleted_at IS NULL")
                .param("userId", userId).update();
    }
}
