package com.smoi.gmail;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import com.smoi.document.DocumentService;
import com.smoi.google.GoogleAccountRepository;
import com.smoi.google.GoogleOAuthService;
import com.smoi.google.GoogleProperties;
import com.smoi.llm.LlmUnavailableException;
import com.smoi.task.Task;
import com.smoi.task.TaskRepository;
import com.smoi.task.TaskService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Gmail sync and what the user can do with an email (FR-05.02 to FR-05.07, FR-02.05, FR-06.02).
 *
 * <h2>Sync</h2>
 * The desktop asks for a sync every couple of minutes while it runs ({@code POST /api/email/sync}).
 * <ol>
 *   <li>First time (no saved historyId): {@code messages.list} with the bounded query
 *       {@code is:unread category:primary newer_than:1d}, at most {@code max-results} messages.
 *       These are stored as already announced, so connecting doesn't set off a burst of alerts.</li>
 *   <li>After that: {@code history.list} from the saved historyId, which returns only what changed.
 *       New messages are kept if they are unread primary inbox mail, the same filter as above.</li>
 *   <li>If Gmail answers 404 to the history call, the saved id has expired (Gmail keeps about a
 *       week): a bounded full sync runs again, and messages already stored are skipped.</li>
 * </ol>
 * Messages are stored once per Gmail id (a unique index), then classified a few per sync, so a
 * slow local model never makes one request take minutes.
 *
 * <h2>Alerts</h2>
 * {@link EmailRepository#claimAlerts} hands out each important email once, ever, and the alert
 * carries no email content: the desktop shows only "You've got an important email".
 *
 * <p>Nothing here sends, deletes or changes mail: reading never changes read/unread state.
 */
@Service
public class EmailService {

    private static final Logger log = LoggerFactory.getLogger(EmailService.class);
    /** Labels Gmail uses for the non-primary inbox tabs. */
    private static final Set<String> OTHER_TABS = Set.of("CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS");
    static final int CLASSIFY_PER_SYNC = 10;

    private final GmailClient gmail;
    private final EmailRepository emails;
    private final EmailClassifier classifier;
    private final GoogleOAuthService oauth;
    private final GoogleAccountRepository accounts;
    private final GoogleProperties props;
    private final TaskService tasks;
    private final DocumentService documents;

    public EmailService(GmailClient gmail, EmailRepository emails, EmailClassifier classifier, GoogleOAuthService oauth,
                        GoogleAccountRepository accounts, GoogleProperties props, TaskService tasks, DocumentService documents) {
        this.gmail = gmail;
        this.emails = emails;
        this.classifier = classifier;
        this.oauth = oauth;
        this.accounts = accounts;
        this.props = props;
        this.tasks = tasks;
        this.documents = documents;
    }

    /**
     * @param fullSync      true when this was a bounded full sync (first time, or history expired)
     * @param newMessages   messages stored by this sync
     * @param classified    emails classified by this sync
     * @param unclassified  emails still waiting for classification (a later sync continues)
     */
    public record SyncResult(boolean fullSync, int newMessages, int classified, int unclassified) {
    }

    public SyncResult sync(UUID userId) {
        GoogleAccountRepository.Account account = oauth.connectedAccount(userId);
        if (account.googleEmail().isEmpty()) {
            accounts.setEmail(userId, gmail.profile(userId).emailAddress());
        }
        int max = props.gmail().maxResults();
        boolean full = account.gmailHistoryId() == null;
        boolean firstEver = full;
        List<String> candidates;
        String historyId;
        if (!full) {
            try {
                GmailClient.History h = gmail.history(userId, account.gmailHistoryId(), max);
                candidates = h.addedMessageIds();
                historyId = h.historyId();
            } catch (GmailClient.HistoryExpiredException e) {
                log.info("Gmail history expired; running a bounded full sync");
                full = true;
                candidates = null;
                historyId = null;
            }
        } else {
            candidates = null;
            historyId = null;
        }
        if (full) {
            // Read the current historyId first, so nothing that arrives during the list is missed.
            historyId = gmail.profile(userId).historyId();
            candidates = gmail.listMessageIds(userId, props.gmail().firstSyncQuery(), max);
        }

        Set<String> known = emails.knownGmailIds(userId, candidates);
        int stored = 0;
        for (String id : candidates) {
            if (known.contains(id)) {
                continue;
            }
            GmailClient.Message m = gmail.message(userId, id).orElse(null);
            // The full sync's query already filtered; history results need the same filter here.
            if (m == null || (!full && !unreadPrimary(m.labelIds()))) {
                continue;
            }
            if (emails.insertIfNew(userId, m, firstEver)) {
                stored++;
            }
        }
        accounts.saveHistoryId(userId, historyId);

        int classified = classifySome(userId);
        emails.settleNonAlerts(userId);
        return new SyncResult(full, stored, classified, emails.unclassified(userId, 1000).size());
    }

    private int classifySome(UUID userId) {
        if (!classifier.enabled()) {
            return 0;
        }
        int done = 0;
        for (EmailRepository.Email e : emails.unclassified(userId, CLASSIFY_PER_SYNC)) {
            try {
                EmailClassifier.Result r = classifier.classify(e.fromAddress(), e.subject(), e.bodyText());
                if (r.classified()) {
                    emails.saveClassification(userId, e.id(), r.category(), r.summary());
                    done++;
                }
            } catch (LlmUnavailableException ex) {
                // Try again on the next sync; mail is still listed, just without a category.
                log.warn("LLM unavailable while classifying email; will retry next sync");
                break;
            }
        }
        return done;
    }

    static boolean unreadPrimary(List<String> labels) {
        return labels.contains("UNREAD") && labels.contains("INBOX") && labels.stream().noneMatch(OTHER_TABS::contains);
    }

    // ---- reading --------------------------------------------------------------------------------

    public record EmailView(UUID id, String from, String subject, Instant receivedAt, String category, String summary,
                            String gmailLink, boolean indexed, UUID taskId) {
    }

    /** Works offline from Google: listing reads only what is stored. */
    public List<EmailView> list(UUID userId, int limit) {
        String account = accounts.find(userId).map(GoogleAccountRepository.Account::googleEmail).orElse("");
        List<EmailView> out = new ArrayList<>();
        for (EmailRepository.Email e : emails.list(userId, limit)) {
            out.add(view(e, account));
        }
        return out;
    }

    public List<EmailRepository.Alert> claimAlerts(UUID userId) {
        return emails.claimAlerts(userId);
    }

    // ---- actions the user takes -----------------------------------------------------------------

    /**
     * Makes a task from an email, linking back to it (FR-02.05, FR-05.06). The user asked for this
     * in the app; an email can't trigger it. Doing it twice returns the same task.
     */
    public Task toTask(UUID userId, UUID emailId, String title, Instant dueAt) {
        EmailRepository.Email e = emails.find(userId, emailId).orElseThrow(TaskService.NotFoundException::new);
        if (e.taskId() != null) {
            return tasks.findTask(userId, e.taskId()).orElseThrow(TaskService.NotFoundException::new);
        }
        String account = accounts.find(userId).map(GoogleAccountRepository.Account::googleEmail).orElse("");
        String t = title == null || title.isBlank() ? (e.subject().isBlank() ? "Email from " + e.fromAddress() : e.subject()) : title.strip();
        t = t.length() > 300 ? t.substring(0, 300) : t;
        String description = "From an email: " + GmailClient.messageLink(account, e.gmailId());
        UUID taskId = UUID.randomUUID();
        Task created = tasks.saveTask(userId, taskId, new TaskRepository.Fields(t, description, "normal", "email", dueAt, null, Instant.now()));
        UUID linked = emails.linkTask(userId, emailId, taskId);
        if (linked != null && !linked.equals(taskId)) {
            // Another request linked a task first; keep that one and drop ours.
            tasks.deleteTask(userId, taskId);
            return tasks.findTask(userId, linked).orElseThrow(TaskService.NotFoundException::new);
        }
        return created;
    }

    /** Adds an email to SMOI Brain (FR-06.02). Off unless the user picks the email. */
    public EmailView index(UUID userId, UUID emailId) {
        EmailRepository.Email e = emails.find(userId, emailId).orElseThrow(TaskService.NotFoundException::new);
        if (e.documentId() == null) {
            // Plain sentences rather than "From:" headers, which would make type detection see an
            // email message (message/rfc822) instead of plain text.
            String text = "Email: " + e.subject() + "\n\nSent by " + e.fromAddress() + " on " + e.receivedAt() + ".\n\n" + e.bodyText();
            String name = "Email - " + (e.subject().isBlank() ? e.gmailId() : e.subject().replaceAll("[\\\\/:*?\"<>|]", " ")) + ".txt";
            DocumentService.UploadResult r = documents.upload(userId, name.length() > 120 ? name.substring(0, 116) + ".txt" : name,
                    text.getBytes(StandardCharsets.UTF_8));
            emails.setDocument(userId, emailId, r.document().id());
        }
        return view(emails.find(userId, emailId).orElseThrow(), accounts.find(userId).map(GoogleAccountRepository.Account::googleEmail).orElse(""));
    }

    public EmailView unindex(UUID userId, UUID emailId) {
        EmailRepository.Email e = emails.find(userId, emailId).orElseThrow(TaskService.NotFoundException::new);
        if (e.documentId() != null) {
            try {
                documents.delete(userId, e.documentId());
            } catch (DocumentService.DocumentNotFoundException ignored) {
                // Already deleted in SMOI Brain.
            }
            emails.setDocument(userId, emailId, null);
        }
        return view(emails.find(userId, emailId).orElseThrow(), accounts.find(userId).map(GoogleAccountRepository.Account::googleEmail).orElse(""));
    }

    /** Deletes stored emails and the SMOI Brain documents made from them (NFR-04.04). */
    public int deleteAll(UUID userId) {
        List<UUID> docs = emails.deleteAll(userId);
        for (UUID d : docs) {
            try {
                documents.delete(userId, d);
            } catch (DocumentService.DocumentNotFoundException ignored) {
                // Already deleted.
            }
        }
        return docs.size();
    }

    private static EmailView view(EmailRepository.Email e, String account) {
        return new EmailView(e.id(), e.fromAddress(), e.subject(), e.receivedAt(), e.category(), e.summary(),
                GmailClient.messageLink(account, e.gmailId()), e.documentId() != null, e.taskId());
    }
}
