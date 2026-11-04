package com.smoi.command;

import java.time.Instant;
import java.time.LocalDate;

/**
 * What SMOI understood a command to mean (FR-03.04). Nothing has been done yet: the desktop
 * shows this, and acts only after the user confirms (FR-03.06). Calendar and email changes are
 * further turned into a Google proposal with its own preview and confirmation (FR-04.04, FR-05.08).
 *
 * <p>At most one of the drafts ({@code task}, {@code reminder}, {@code question}, {@code event},
 * {@code eventChange}, {@code email}) is set when the intent is usable; all are null for
 * {@code unknown}, and when {@code problem} explains why the command can't be used as it stands.
 * {@code list_events} needs no draft.
 *
 * @param intent    one of {@link Intent}'s ids
 * @param available false for intents whose module isn't built yet
 * @param problem   a plain sentence for the user, or null
 */
public record Proposal(String intent, boolean available, TaskDraft task, ReminderDraft reminder, String question,
                       String problem, EventDraft event, EventChangeDraft eventChange, EmailDraft email) {

    public Proposal(String intent, boolean available, TaskDraft task, ReminderDraft reminder, String question, String problem) {
        this(intent, available, task, reminder, question, problem, null, null, null);
    }

    public record TaskDraft(String title, Instant dueAt, String priority) {
    }

    /** {@code weekdays}: bit n-1 for ISO day n, as in the reminders table. */
    public record ReminderDraft(String title, Instant firstAt, String repeat, int weekdays) {
    }

    /** A new calendar event (FR-04.03). */
    public record EventDraft(String title, Instant start, Instant end) {
    }

    /**
     * A change to an existing event (FR-04.04): which event, by words from its title and its day,
     * and for an update the new start (null for a delete). The desktop finds the event and asks
     * for a proposal with a before/after preview.
     */
    public record EventChangeDraft(String query, LocalDate day, Instant newStart, boolean delete) {
    }

    /** A Gmail draft to propose (FR-05.08). The recipient must appear in what the user said. */
    public record EmailDraft(String to, String subject, String body) {
    }

    static Proposal unknown(String problem) {
        return new Proposal(Intent.UNKNOWN.id, true, null, null, null, problem);
    }
}
