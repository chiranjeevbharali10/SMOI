package com.smoi.task;

import java.time.DateTimeException;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Saves and deletes tasks and reminders using the sync rule in ADR 0014: a change is applied
 * only if it is at least as new as the stored one, and a delete always wins.
 *
 * <p>A save always answers with the row as it now stands. When the change lost to a newer one,
 * that is the newer row, and the device replaces its copy with it.
 */
@Service
public class TaskService {

    private final TaskRepository tasks;
    private final ReminderRepository reminders;

    public TaskService(TaskRepository tasks, ReminderRepository reminders) {
        this.tasks = tasks;
        this.reminders = reminders;
    }

    @Transactional
    public Task saveTask(UUID userId, UUID id, TaskRepository.Fields fields) {
        return tasks.upsert(userId, id, fields).orElseGet(() -> {
            Task current = tasks.findIncludingDeleted(userId, id).orElseThrow(NotFoundException::new);
            if (current.deletedAt() != null) {
                throw new GoneException();
            }
            return current; // a newer change is already stored
        });
    }

    @Transactional
    public void deleteTask(UUID userId, UUID id) {
        if (!tasks.softDelete(userId, id)) {
            Task current = tasks.findIncludingDeleted(userId, id).orElseThrow(NotFoundException::new);
            if (current.deletedAt() == null) {
                throw new IllegalStateException("Task " + id + " is active but could not be deleted");
            }
            // already deleted: deleting again is a no-op, so a retried request succeeds
        }
    }

    public List<Task> listTasks(UUID userId, boolean overdueOnly) {
        return overdueOnly ? tasks.listOverdue(userId) : tasks.listActive(userId);
    }

    @Transactional
    public Reminder saveReminder(UUID userId, UUID id, ReminderRepository.Fields fields) {
        validate(fields);
        if (fields.taskId() != null && !tasks.existsActive(userId, fields.taskId())) {
            throw new IllegalArgumentException("The reminder's task doesn't exist.");
        }
        return reminders.upsert(userId, id, fields).orElseGet(() -> {
            Reminder current = reminders.findIncludingDeleted(userId, id).orElseThrow(NotFoundException::new);
            if (current.deletedAt() != null) {
                throw new GoneException();
            }
            return current;
        });
    }

    @Transactional
    public void deleteReminder(UUID userId, UUID id) {
        if (!reminders.softDelete(userId, id)) {
            reminders.findIncludingDeleted(userId, id).orElseThrow(NotFoundException::new);
        }
    }

    public List<Reminder> listReminders(UUID userId) {
        return reminders.listActive(userId);
    }

    public record Changes(List<Task> tasks, List<Reminder> reminders) {
    }

    /** Active rows plus recent deletions, for a device bringing its copy up to date. */
    @Transactional(readOnly = true)
    public Changes changes(UUID userId) {
        return new Changes(tasks.changes(userId), reminders.changes(userId));
    }

    private static void validate(ReminderRepository.Fields f) {
        try {
            ZoneId.of(f.timeZone());
        } catch (DateTimeException e) {
            throw new IllegalArgumentException("Unknown time zone: " + f.timeZone());
        }
        if ("weekdays".equals(f.repeat()) && f.weekdays() == 0) {
            throw new IllegalArgumentException("A weekday reminder needs at least one day.");
        }
    }

    /** The row doesn't exist for this user (or belongs to someone else: same answer, NFR-03.04). */
    public static class NotFoundException extends RuntimeException {
        NotFoundException() {
            super("Not found.");
        }
    }

    /** The row was deleted. Deletes always win, so the change was not applied. */
    public static class GoneException extends RuntimeException {
        GoneException() {
            super("This was deleted.");
        }
    }
}
