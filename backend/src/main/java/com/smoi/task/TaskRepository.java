package com.smoi.task;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * SQL for the tasks table. Every query filters by {@code user_id}. Queries filter by
 * {@code deleted_at IS NULL} too, except {@link #findIncludingDeleted} and {@link #changes},
 * which deliberately read deleted rows so a device learns that a task it holds was deleted.
 */
@Repository
public class TaskRepository {

    private static final String COLUMNS = """
            id, user_id, title, description, priority, category, due_at, completed_at, edited_at,
            created_at, updated_at, deleted_at""";

    private final JdbcClient jdbc;

    public TaskRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record Fields(String title, String description, String priority, String category,
                         Instant dueAt, Instant completedAt, Instant editedAt) {
    }

    /**
     * Creates the task, or updates it if this change is at least as new as the stored one.
     * Returns empty when nothing was written: the stored change is newer, the task was
     * deleted, or the id belongs to another user. The edit time is capped at the server's
     * clock, so a device with a clock in the future can't lock a task against later edits.
     */
    public Optional<Task> upsert(UUID userId, UUID id, Fields f) {
        return jdbc.sql("""
                        INSERT INTO tasks (id, user_id, title, description, priority, category, due_at, completed_at, edited_at)
                        VALUES (:id, :userId, :title, :description, :priority, :category, :dueAt, :completedAt,
                                LEAST(CAST(:editedAt AS timestamptz), now()))
                        ON CONFLICT (id) DO UPDATE
                           SET title = EXCLUDED.title, description = EXCLUDED.description,
                               priority = EXCLUDED.priority, category = EXCLUDED.category,
                               due_at = EXCLUDED.due_at, completed_at = EXCLUDED.completed_at,
                               edited_at = EXCLUDED.edited_at
                         WHERE tasks.user_id = EXCLUDED.user_id
                           AND tasks.deleted_at IS NULL
                           AND tasks.edited_at <= EXCLUDED.edited_at
                        RETURNING %s
                        """.formatted(COLUMNS))
                .param("id", id)
                .param("userId", userId)
                .param("title", f.title())
                .param("description", f.description())
                .param("priority", f.priority())
                .param("category", f.category())
                .param("dueAt", ts(f.dueAt()))
                .param("completedAt", ts(f.completedAt()))
                .param("editedAt", ts(f.editedAt()))
                .query(Task.class)
                .optional();
    }

    /** The user's task, deleted or not. Empty if it doesn't exist or belongs to someone else. */
    public Optional<Task> findIncludingDeleted(UUID userId, UUID id) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM tasks WHERE id = :id AND user_id = :userId")
                .param("id", id)
                .param("userId", userId)
                .query(Task.class)
                .optional();
    }

    public boolean existsActive(UUID userId, UUID id) {
        return jdbc.sql("SELECT count(*) FROM tasks WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", id)
                .param("userId", userId)
                .query(Integer.class)
                .single() == 1;
    }

    /** Open tasks first, by due date (undated last), then completed ones, newest first. */
    public List<Task> listActive(UUID userId) {
        return jdbc.sql("""
                        SELECT %s FROM tasks
                         WHERE user_id = :userId AND deleted_at IS NULL
                         ORDER BY completed_at IS NOT NULL, due_at ASC NULLS LAST, completed_at DESC, created_at, id
                        """.formatted(COLUMNS))
                .param("userId", userId)
                .query(Task.class)
                .list();
    }

    /** Open tasks whose due date has passed (FR-02.06), most overdue first. */
    public List<Task> listOverdue(UUID userId) {
        return jdbc.sql("""
                        SELECT %s FROM tasks
                         WHERE user_id = :userId AND deleted_at IS NULL
                           AND completed_at IS NULL AND due_at < now()
                         ORDER BY due_at, id
                        """.formatted(COLUMNS))
                .param("userId", userId)
                .query(Task.class)
                .list();
    }

    /**
     * What a device needs to bring its copy up to date: active tasks, plus tasks deleted in the
     * last 30 days so the device can drop them. This deliberately reads deleted rows.
     */
    public List<Task> changes(UUID userId) {
        return jdbc.sql("""
                        SELECT %s FROM tasks
                         WHERE user_id = :userId
                           AND (deleted_at IS NULL OR deleted_at > now() - interval '30 days')
                         ORDER BY created_at, id
                        """.formatted(COLUMNS))
                .param("userId", userId)
                .query(Task.class)
                .list();
    }

    /**
     * Soft-deletes the task and the reminders attached to it. Returns false if the user has no
     * such active task.
     */
    public boolean softDelete(UUID userId, UUID id) {
        jdbc.sql("""
                        UPDATE reminders SET deleted_at = now()
                         WHERE task_id = :id AND user_id = :userId AND deleted_at IS NULL
                        """)
                .param("id", id)
                .param("userId", userId)
                .update();
        return jdbc.sql("UPDATE tasks SET deleted_at = now() WHERE id = :id AND user_id = :userId AND deleted_at IS NULL")
                .param("id", id)
                .param("userId", userId)
                .update() == 1;
    }

    static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }
}
