package com.smoi.command;

import java.time.Instant;

/**
 * What SMOI understood a command to mean (FR-03.04). Nothing has been done yet: the desktop
 * shows this, and creates the task or reminder only after the user confirms (FR-03.06).
 *
 * <p>Exactly one of {@code task}, {@code reminder} or {@code question} is set when the intent
 * is usable; all are null for {@code unknown}, for intents that aren't available yet, and when
 * {@code problem} explains why the command can't be used as it stands.
 *
 * @param intent    one of {@link Intent}'s ids
 * @param available false for intents whose module isn't built yet (calendar and email)
 * @param problem   a plain sentence for the user, or null
 */
public record Proposal(String intent, boolean available, TaskDraft task, ReminderDraft reminder, String question,
                       String problem) {

    public record TaskDraft(String title, Instant dueAt, String priority) {
    }

    /** {@code weekdays}: bit n-1 for ISO day n, as in the reminders table. */
    public record ReminderDraft(String title, Instant firstAt, String repeat, int weekdays) {
    }

    static Proposal unknown(String problem) {
        return new Proposal(Intent.UNKNOWN.id, true, null, null, null, problem);
    }
}
