package com.smoi.command;

import java.util.Arrays;
import java.util.Optional;

/**
 * The documented intent list (FR-03.04). This is the allowlist: whatever the model says, a
 * command becomes one of these or {@link #UNKNOWN}. An intent only produces a proposal: creating,
 * changing or deleting an event, or creating a draft, still needs a preview and the user's
 * confirmation (FR-04.04, FR-05.08), and nothing can send or delete email (FR-05.13).
 */
public enum Intent {
    CREATE_TASK("create_task", true),
    CREATE_REMINDER("create_reminder", true),
    ASK_BRAIN("ask_brain", true),
    LIST_EVENTS("list_events", true),
    CREATE_EVENT("create_event", true),
    UPDATE_EVENT("update_event", true),
    DELETE_EVENT("delete_event", true),
    DRAFT_EMAIL("draft_email", true),
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
