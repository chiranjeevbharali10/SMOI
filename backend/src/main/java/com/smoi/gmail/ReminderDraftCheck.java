package com.smoi.gmail;

import java.util.UUID;

import com.smoi.google.GoogleExceptions;
import com.smoi.task.Reminder;
import com.smoi.task.ReminderRepository;
import com.smoi.task.TaskService;
import org.springframework.stereotype.Service;

/**
 * "Remind me to send this tomorrow at 9" (FR-05.10, FR-05.11). Just before such a reminder fires,
 * the desktop asks here whether the draft still exists. If the user already sent or deleted it in
 * Gmail, the reminder is cancelled and the user is told why, instead of being nagged about a draft
 * that's gone.
 *
 * <p>If Google can't be asked (offline, disconnected, rate-limited), the reminder fires as normal:
 * a reminder that fires needlessly is better than one that is silently lost.
 */
@Service
public class ReminderDraftCheck {

    private final ReminderRepository reminders;
    private final DraftRepository drafts;
    private final GmailClient gmail;

    public ReminderDraftCheck(ReminderRepository reminders, DraftRepository drafts, GmailClient gmail) {
        this.reminders = reminders;
        this.drafts = drafts;
        this.gmail = gmail;
    }

    /**
     * @param fire    whether the desktop should show the reminder
     * @param checked whether the draft could be checked with Gmail
     * @param message why it was cancelled, for the user, or null
     */
    public record Result(boolean fire, boolean checked, String message) {
    }

    public Result check(UUID userId, UUID reminderId) {
        Reminder r = reminders.findIncludingDeleted(userId, reminderId).orElseThrow(TaskService.NotFoundException::new);
        if (r.deletedAt() != null) {
            return new Result(false, true, "draft_gone".equals(r.cancelledReason()) ? goneMessage(null) : null);
        }
        if (r.draftId() == null) {
            return new Result(true, false, null);
        }
        DraftRepository.Draft d = drafts.find(userId, r.draftId()).orElse(null);
        boolean gone;
        if (d == null || d.goneAt() != null) {
            gone = true;
        } else {
            try {
                gone = !gmail.draftExists(userId, d.gmailDraftId());
            } catch (GoogleExceptions.Unavailable | GoogleExceptions.NotConnected | GoogleExceptions.ReconnectRequired
                     | GoogleExceptions.NotConfigured | GoogleExceptions.MissingScope | GoogleExceptions.ApiError e) {
                return new Result(true, false, null);
            }
        }
        if (!gone) {
            return new Result(true, true, null);
        }
        if (d != null) {
            drafts.markGone(userId, d.id());
        }
        reminders.cancel(userId, reminderId, "draft_gone");
        return new Result(false, true, goneMessage(d == null ? null : d.subject()));
    }

    private static String goneMessage(String subject) {
        String which = subject == null || subject.isBlank() ? "Your draft" : "Your draft “" + subject + "”";
        return which + " was sent or deleted in Gmail, so I cancelled its reminder.";
    }
}
