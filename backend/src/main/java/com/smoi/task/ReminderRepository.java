package com.smoi.task;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import static com.smoi.task.TaskRepository.ts;

/** SQL for the reminders table. Same scoping and sync rule as {@link TaskRepository}. */
@Repository
public class ReminderRepository {

    private static final String COLUMNS = """
            id, user_id, task_id, title, first_at, repeat, weekdays, time_zone, last_fired_at, draft_id, cancelled_reason, edited_at,
            created_at, updated_at, deleted_at""";

    private final JdbcClient jdbc;

    public ReminderRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** @param draftId a Gmail draft SMOI created that this reminder is about (FR-05.10), or null */
    public record Fields(UUID taskId, String title, Instant firstAt, String repeat, int weekdays, String timeZone,
                         Instant lastFiredAt, Instant editedAt, UUID draftId) {

        public Fields(UUID taskId, String title, Instant firstAt, String repeat, int weekdays, String timeZone,
                      Instant lastFiredAt, Instant editedAt) {
            this(taskId, title, firstAt, repeat, weekdays, timeZone, lastFiredAt, editedAt, null);
        }
    }

    /**
     * Same contract as {@link TaskRepository#upsert}. {@code last_fired_at} only moves forward,
     * so a device that saw an older occurrence can't make a newer one fire again.
     */
    public Optional<Reminder> upsert(UUID userId, UUID id, Fields f) {
        return jdbc.sql("""
                        INSERT INTO reminders (id, user_id, task_id, title, first_at, repeat, weekdays, time_zone,
                                               last_fired_at, draft_id, edited_at)
                        VALUES (:id, :userId, :taskId, :title, :firstAt, :repeat, :weekdays, :timeZone,
                                :lastFiredAt, :draftId, LEAST(CAST(:editedAt AS timestamptz), now()))
                        ON CONFLICT (id) DO UPDATE
                           SET task_id = EXCLUDED.task_id, title = EXCLUDED.title, first_at = EXCLUDED.first_at,
                               repeat = EXCLUDED.repeat, weekdays = EXCLUDED.weekdays, time_zone = EXCLUDED.time_zone,
                               last_fired_at = GREATEST(reminders.last_fired_at, EXCLUDED.last_fired_at),
                               draft_id = EXCLUDED.draft_id, edited_at = EXCLUDED.edited_at
                         WHERE reminders.user_id = EXCLUDED.user_id
                           AND reminders.deleted_at IS NULL
                           AND reminders.edited_at <= EXCLUDED.edited_at
                        RETURNING %s
                        """.formatted(COLUMNS))
                .param("id", id)
                .param("userId", userId)
                .param("taskId", f.taskId())
                .param("title", f.title())
                .param("firstAt", ts(f.firstAt()))
                .param("repeat", f.repeat())
                .param("weekdays", f.weekdays())
                .param("timeZone", f.timeZone())
                .param("lastFiredAt", ts(f.lastFiredAt()))
                .param("draftId", f.draftId())
                .param("editedAt", ts(f.editedAt()))
                .query(Reminder.class)
                .optional();
    }

    /** Whether the user has this draft (one SMOI created, not deleted). */
    public boolean draftOwned(UUID userId, UUID draftId) {
        return jdbc.sql("SELECT count(*) FROM gmail_drafts WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", draftId).param("userId", userId)
                .query(Long.class).single() == 1;
    }

    public Optional<Reminder> findIncludingDeleted(UUID userId, UUID id) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM reminders WHERE id = :id AND user_id = :userId")
                .param("id", id)
                .param("userId", userId)
                .query(Reminder.class)
                .optional();
    }

    public List<Reminder> listActive(UUID userId) {
        return jdbc.sql("SELECT " + COLUMNS
                        + " FROM reminders WHERE user_id = :userId AND deleted_at IS NULL ORDER BY first_at, id")
                .param("userId", userId)
                .query(Reminder.class)
                .list();
    }

    /** Active reminders and those deleted in the last 30 days; deliberately reads deleted rows. */
    public List<Reminder> changes(UUID userId) {
        return jdbc.sql("""
                        SELECT %s FROM reminders
                         WHERE user_id = :userId
                           AND (deleted_at IS NULL OR deleted_at > now() - interval '30 days')
                         ORDER BY created_at, id
                        """.formatted(COLUMNS))
                .param("userId", userId)
                .query(Reminder.class)
                .list();
    }

    /**
     * Cancels a reminder because its draft is gone (FR-05.11). It is deleted (so the desktop's next
     * sync removes it) with the reason recorded, and edited_at moves on so this wins over older edits.
     */
    public boolean cancel(UUID userId, UUID id, String reason) {
        return jdbc.sql("""
                        UPDATE reminders SET deleted_at = now(), cancelled_reason = :reason, edited_at = now()
                         WHERE id = :id AND user_id = :userId AND deleted_at IS NULL
                        """)
                .param("reason", reason).param("id", id).param("userId", userId)
                .update() == 1;
    }

    public boolean softDelete(UUID userId, UUID id) {
        return jdbc.sql("UPDATE reminders SET deleted_at = now() WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", id)
                .param("userId", userId)
                .update() == 1;
    }
}
