package com.smoi.gmail;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.smoi.actions.GoogleActionService;
import com.smoi.auth.CurrentUser;
import com.smoi.task.TaskController;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Email (FR-05) and drafts (FR-05.08 to FR-05.11). There is deliberately no endpoint that sends,
 * deletes or trashes mail, and none could be written: {@link GmailClient} has no such method.
 */
@RestController
public class EmailController {

    private final EmailService emails;
    private final EmailClassifier classifier;
    private final GoogleActionService actions;
    private final ReminderDraftCheck reminderCheck;

    public EmailController(EmailService emails, EmailClassifier classifier, GoogleActionService actions,
                           ReminderDraftCheck reminderCheck) {
        this.emails = emails;
        this.classifier = classifier;
        this.actions = actions;
        this.reminderCheck = reminderCheck;
    }

    @GetMapping("/api/email")
    public List<EmailService.EmailView> list(@AuthenticationPrincipal Jwt jwt, @RequestParam(defaultValue = "50") int limit) {
        return emails.list(CurrentUser.id(jwt), Math.clamp(limit, 1, 200));
    }

    @PostMapping("/api/email/sync")
    public EmailService.SyncResult sync(@AuthenticationPrincipal Jwt jwt) {
        return emails.sync(CurrentUser.id(jwt));
    }

    /**
     * New important emails, each returned once ever (FR-05.04). No sender, subject or text: the
     * desktop's alert says only that an important email arrived.
     */
    @PostMapping("/api/email/alerts")
    public List<EmailRepository.Alert> alerts(@AuthenticationPrincipal Jwt jwt) {
        return emails.claimAlerts(CurrentUser.id(jwt));
    }

    public record ToTaskRequest(@Size(max = 300) String title, Instant dueAt) {
    }

    /** The user chose "Make a task" on this email (FR-02.05). */
    @PostMapping("/api/email/{id}/task")
    public TaskController.TaskResponse toTask(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
                                              @Valid @RequestBody(required = false) ToTaskRequest r) {
        return TaskController.TaskResponse.from(emails.toTask(CurrentUser.id(jwt), id,
                r == null ? null : r.title(), r == null ? null : r.dueAt()));
    }

    /** Adds the email to SMOI Brain. Off unless the user picks the email (FR-06.02). */
    @PostMapping("/api/email/{id}/index")
    public EmailService.EmailView index(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return emails.index(CurrentUser.id(jwt), id);
    }

    @DeleteMapping("/api/email/{id}/index")
    public EmailService.EmailView unindex(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return emails.unindex(CurrentUser.id(jwt), id);
    }

    public record ClassifyRequest(@Size(max = 500) String from, @Size(max = 1000) String subject,
                                  @NotBlank @Size(max = 20000) String body) {
    }

    /**
     * Classifies text without storing it or touching Google: used by {@code make eval} on the
     * synthetic email set (NFR-09.07). Same classifier, same rules: no tools, two fields out.
     */
    @PostMapping("/api/email/classify")
    public EmailClassifier.Result classify(@Valid @RequestBody ClassifyRequest r) {
        return classifier.classify(r.from() == null ? "" : r.from(), r.subject() == null ? "" : r.subject(), r.body());
    }

    // ---- drafts ---------------------------------------------------------------------------------

    @GetMapping("/api/drafts")
    public List<GoogleActionService.DraftView> drafts(@AuthenticationPrincipal Jwt jwt) {
        return actions.listDrafts(CurrentUser.id(jwt));
    }

    public record DraftRequest(@Size(max = 320) String to, @Size(max = 998) String subject, @Size(max = 20000) String body) {
    }

    /** Proposes a new draft. Nothing is created until the user confirms (POST /api/google/actions/{id}/confirm). */
    @PostMapping("/api/drafts/propose")
    public GoogleActionService.Preview proposeDraft(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody DraftRequest r) {
        return actions.proposeCreateDraft(CurrentUser.id(jwt), r.to(), r.subject(), r.body());
    }

    /** Proposes a change to a draft SMOI created. Fields left out keep their value. */
    @PostMapping("/api/drafts/{id}/propose")
    public GoogleActionService.Preview proposeDraftUpdate(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
                                                          @Valid @RequestBody DraftRequest r) {
        return actions.proposeUpdateDraft(CurrentUser.id(jwt), id, r.to(), r.subject(), r.body());
    }

    // ---- reminders linked to drafts -------------------------------------------------------------

    /**
     * The desktop asks this just before a reminder fires (FR-05.11). If the reminder is about a
     * draft that no longer exists in Gmail, the reminder is cancelled and the answer says why.
     */
    @PostMapping("/api/reminders/{id}/check")
    public ReminderDraftCheck.Result checkReminder(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return reminderCheck.check(CurrentUser.id(jwt), id);
    }
}
