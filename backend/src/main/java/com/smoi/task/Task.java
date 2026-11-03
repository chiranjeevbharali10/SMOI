package com.smoi.task;

import java.time.Instant;
import java.util.UUID;

/** A to-do item. {@code completedAt} is null while the task is open. */
public record Task(
        UUID id,
        UUID userId,
        String title,
        String description,
        String priority,
        String category,
        Instant dueAt,
        Instant completedAt,
        Instant editedAt,
        Instant createdAt,
        Instant updatedAt,
        Instant deletedAt) {
}
