package com.smoi.task;

import java.time.Instant;
import java.util.UUID;

/**
 * A one-time or recurring reminder. {@code weekdays} is a bit set used when
 * {@code repeat = "weekdays"}: bit n-1 for ISO day n (Monday = 1 ... Sunday = 64).
 */
public record Reminder(
        UUID id,
        UUID userId,
        UUID taskId,
        String title,
        Instant firstAt,
        String repeat,
        int weekdays,
        String timeZone,
        Instant lastFiredAt,
        UUID draftId,
        String cancelledReason,
        Instant editedAt,
        Instant createdAt,
        Instant updatedAt,
        Instant deletedAt) {
}
