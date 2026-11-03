package com.smoi.command;

import java.util.Arrays;
import java.util.Optional;

/**
 * The documented intent list (FR-03.04). This is the allowlist: whatever the model says, a
 * command becomes one of these or {@link #UNKNOWN}. None of them deletes, sends or changes
 * existing data, so a command (or text injected into one) can't do anything destructive.
 */
public enum Intent {
    CREATE_TASK("create_task", true),
    CREATE_REMINDER("create_reminder", true),
    ASK_BRAIN("ask_brain", true),
    // Recognised so SMOI can say "not available yet" instead of guessing; built in Phase 8.
    LIST_EVENTS("list_events", false),
    CREATE_EVENT("create_event", false),
    DRAFT_EMAIL("draft_email", false),
    UNKNOWN("unknown", true);

    public final String id;
    /** Whether the module that handles it exists yet. */
    public final boolean available;

    Intent(String id, boolean available) {
        this.id = id;
        this.available = available;
    }

    public static Optional<Intent> of(String id) {
        return Arrays.stream(values()).filter(i -> i.id.equals(id)).findFirst();
    }
}
