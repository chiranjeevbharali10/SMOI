package com.smoi.actions;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import com.smoi.calendar.CalendarClient;
import com.smoi.gmail.DraftMessage;
import com.smoi.gmail.DraftRepository;
import com.smoi.gmail.GmailClient;
import com.smoi.google.GoogleAccountRepository;
import com.smoi.google.GoogleExceptions;
import com.smoi.google.GoogleOAuthService;
import com.smoi.google.GoogleProperties;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Every change SMOI makes in Google goes through here, in two steps (FR-04.04, FR-04.05, FR-05.08,
 * FR-05.09, NFR-02.03):
 *
 * <ol>
 *   <li><b>Propose.</b> The change is validated and stored as a {@code google_actions} row, with
 *       what the user needs to decide: the event or draft as it is now, as it would be, and any
 *       events it would overlap. Nothing reaches Google.</li>
 *   <li><b>Confirm.</b> The user confirms that row by id, and only then is it applied, exactly as it
 *       was shown. The id is the idempotency key: confirming again, or retrying after a timeout,
 *       returns the first result instead of applying it twice.</li>
 * </ol>
 *
 * <p>Retries are safe at Google's end too: a new event's Google id is derived from the action id,
 * so a create that reached Google before gets 409 and the existing event is returned; and a new
 * draft carries a Message-ID derived from the action id, which is looked up before creating.
 *
 * <p>Nothing in an email can call this: classification has no tools, and proposals are made only
 * from the user's own commands and clicks, then confirmed by the user.
 */
@Service
public class GoogleActionService {

    static final int MAX_TITLE = 300;
    static final Duration MAX_EVENT = Duration.ofDays(14);
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final GoogleActionRepository actions;
    private final CalendarClient calendar;
    private final GmailClient gmail;
    private final DraftRepository drafts;
    private final GoogleOAuthService oauth;
    private final GoogleAccountRepository accounts;
    private final GoogleProperties props;
    private final Clock clock;

    @Autowired
    public GoogleActionService(GoogleActionRepository actions, CalendarClient calendar, GmailClient gmail, DraftRepository drafts,
                               GoogleOAuthService oauth, GoogleAccountRepository accounts, GoogleProperties props) {
        this(actions, calendar, gmail, drafts, oauth, accounts, props, Clock.systemUTC());
    }

    GoogleActionService(GoogleActionRepository actions, CalendarClient calendar, GmailClient gmail, DraftRepository drafts,
                        GoogleOAuthService oauth, GoogleAccountRepository accounts, GoogleProperties props, Clock clock) {
        this.actions = actions;
        this.calendar = calendar;
        this.gmail = gmail;
        this.drafts = drafts;
        this.oauth = oauth;
        this.accounts = accounts;
        this.props = props;
        this.clock = clock;
    }

    // ---- what the desktop sees ------------------------------------------------------------------

    public record EventView(String id, String title, Instant start, Instant end, String startDate, String endDate,
                            String link, List<Integer> reminderMinutes) {
        public static EventView of(CalendarClient.Event e) {
            return new EventView(e.id(), e.title(), e.start(), e.end(),
                    e.startDate() == null ? null : e.startDate().toString(), e.endDate() == null ? null : e.endDate().toString(),
                    e.htmlLink(), e.reminderMinutes());
        }
    }

    public record DraftView(UUID id, String to, String subject, String body, String gmailLink, boolean gone) {
    }

    /**
     * A proposal for the user to confirm.
     *
     * @param before    the event or draft as it is now (null when creating)
     * @param after     as it would be (null when deleting)
     * @param conflicts events in the primary calendar that overlap the new time (FR-04.05)
     */
    public record Preview(UUID id, String kind, Instant expiresAt, Object before, Object after, List<EventView> conflicts) {
    }

    public record Outcome(UUID id, String kind, String status, JsonNode result) {
    }

    // ---- calendar proposals ---------------------------------------------------------------------

    /** What the user asked to change. For create, {@code eventId} is null. */
    public record EventChange(String title, Instant start, Instant end, List<Integer> reminderMinutes) {
    }

    public Preview proposeCreateEvent(UUID userId, EventChange c) {
        CalendarClient.Fields f = validate(c, null);
        List<EventView> conflicts = conflicts(userId, f.start(), f.end(), null);
        Map<String, Object> payload = eventPayload(null, f);
        return preview(actions.insert(userId, "create_event", JSON.writeValueAsString(payload), expiry()),
                null, payload, conflicts);
    }

    /** Fields left null in {@code c} keep their current value. */
    public Preview proposeUpdateEvent(UUID userId, String eventId, EventChange c) {
        CalendarClient.Event current = calendar.get(userId, eventId)
                .orElseThrow(() -> new IllegalArgumentException("That event no longer exists."));
        if (current.allDay()) {
            throw new IllegalArgumentException("SMOI can't change all-day events yet. Change it in Google Calendar.");
        }
        CalendarClient.Fields f = validate(c, current);
        List<EventView> conflicts = conflicts(userId, f.start(), f.end(), eventId);
        Map<String, Object> payload = eventPayload(eventId, f);
        return preview(actions.insert(userId, "update_event", JSON.writeValueAsString(payload), expiry()),
                EventView.of(current), payload, conflicts);
    }

    public Preview proposeDeleteEvent(UUID userId, String eventId) {
        CalendarClient.Event current = calendar.get(userId, eventId)
                .orElseThrow(() -> new IllegalArgumentException("That event no longer exists."));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("eventId", current.id());
        return preview(actions.insert(userId, "delete_event", JSON.writeValueAsString(payload), expiry()),
                EventView.of(current), null, List.of());
    }

    // ---- draft proposals ------------------------------------------------------------------------

    public Preview proposeCreateDraft(UUID userId, String to, String subject, String body) {
        oauth.connectedAccount(userId);
        DraftMessage m = new DraftMessage(to, subject, body);
        Map<String, Object> payload = draftPayload(null, m);
        return preview(actions.insert(userId, "create_draft", JSON.writeValueAsString(payload), expiry()), null, payload, List.of());
    }

    /** Only drafts SMOI created can be updated (FR-05.09). */
    public Preview proposeUpdateDraft(UUID userId, UUID draftId, String to, String subject, String body) {
        oauth.connectedAccount(userId);
        DraftRepository.Draft d = drafts.find(userId, draftId)
                .orElseThrow(() -> new IllegalArgumentException("SMOI can only change drafts it created."));
        if (d.goneAt() != null) {
            throw new IllegalArgumentException("That draft was sent or deleted in Gmail.");
        }
        DraftMessage m = new DraftMessage(to == null ? d.toAddress() : to, subject == null ? d.subject() : subject,
                body == null ? d.body() : body);
        Map<String, Object> payload = draftPayload(draftId, m);
        return preview(actions.insert(userId, "update_draft", JSON.writeValueAsString(payload), expiry()),
                draftView(userId, d), payload, List.of());
    }

    // ---- confirming -----------------------------------------------------------------------------

    /**
     * Applies a proposal the user confirmed. Safe to call again: an applied action returns its
     * stored result.
     *
     * @throws java.util.NoSuchElementException not found for this user
     * @throws ActionNotApplicable              expired, failed, or being applied by another request
     */
    public Outcome confirm(UUID userId, UUID actionId) {
        Optional<GoogleActionRepository.Claim> claim = actions.claim(userId, actionId);
        if (claim.isEmpty()) {
            GoogleActionRepository.Action a = actions.find(userId, actionId).orElseThrow();
            if ("applied".equals(a.status()) || "failed".equals(a.status())) {
                return outcome(a);
            }
            if ("applying".equals(a.status())) {
                throw new ActionNotApplicable("This change is being applied. Check again in a moment.");
            }
            throw new ActionNotApplicable("This proposal has expired. Ask again to make a new one.");
        }
        GoogleActionRepository.Action a = claim.get().action();
        JsonNode p = JSON.readTree(a.payload());
        Object result;
        try {
            result = apply(userId, a, p);
        } catch (GoogleExceptions.Unavailable | GoogleExceptions.ApiError | GoogleExceptions.ReconnectRequired e) {
            // Nothing was recorded as done; the user can confirm again (safely, see the class comment).
            actions.release(userId, actionId);
            throw e;
        } catch (TargetGone e) {
            actions.failed(userId, actionId, JSON.writeValueAsString(Map.of("problem", e.getMessage())));
            return outcome(actions.find(userId, actionId).orElseThrow());
        }
        actions.applied(userId, actionId, JSON.writeValueAsString(result));
        return outcome(actions.find(userId, actionId).orElseThrow());
    }

    private Object apply(UUID userId, GoogleActionRepository.Action a, JsonNode p) {
        switch (a.kind()) {
            case "create_event" -> {
                return EventView.of(calendar.insert(userId, googleEventId(a.id()), fields(p)));
            }
            case "update_event" -> {
                return EventView.of(calendar.patch(userId, p.path("eventId").asString(), fields(p))
                        .orElseThrow(() -> new TargetGone("The event was deleted before the change was applied.")));
            }
            case "delete_event" -> {
                calendar.delete(userId, p.path("eventId").asString());
                return Map.of("deleted", p.path("eventId").asString());
            }
            case "create_draft" -> {
                DraftMessage m = message(p);
                String messageId = "smoi-" + a.id() + "@smoi.local";
                // A previous attempt may have reached Gmail before failing; reuse what it made.
                GmailClient.DraftRef ref = gmail.findDraft(userId, messageId)
                        .orElseGet(() -> gmail.createDraft(userId, m, messageId));
                return draftView(userId, drafts.insert(userId, ref, m));
            }
            case "update_draft" -> {
                UUID draftId = UUID.fromString(p.path("draftId").asString());
                DraftRepository.Draft d = drafts.find(userId, draftId).orElseThrow(() -> new TargetGone("SMOI no longer has that draft."));
                DraftMessage m = message(p);
                Optional<GmailClient.DraftRef> ref = gmail.updateDraft(userId, d.gmailDraftId(), m);
                if (ref.isEmpty()) {
                    drafts.markGone(userId, draftId);
                    throw new TargetGone("That draft was sent or deleted in Gmail.");
                }
                return draftView(userId, drafts.update(userId, draftId, ref.get(), m));
            }
            default -> throw new IllegalStateException("Unknown action kind");
        }
    }

    /**
     * Google event ids allow the characters a-v and 0-9. A UUID's hex digits are all in that set, so
     * "smoi" plus the action id's hex is a valid id that's the same on every retry.
     */
    static String googleEventId(UUID actionId) {
        return "smoi" + actionId.toString().replace("-", "");
    }

    // ---- helpers --------------------------------------------------------------------------------

    public List<DraftView> listDrafts(UUID userId) {
        List<DraftView> out = new ArrayList<>();
        for (DraftRepository.Draft d : drafts.list(userId)) {
            out.add(draftView(userId, d));
        }
        return out;
    }

    public DraftView draftView(UUID userId, DraftRepository.Draft d) {
        String account = accounts.find(userId).map(GoogleAccountRepository.Account::googleEmail).orElse("");
        return new DraftView(d.id(), d.toAddress(), d.subject(), d.body(), GmailClient.draftLink(account, d.gmailMessageId()),
                d.goneAt() != null);
    }

    private CalendarClient.Fields validate(EventChange c, CalendarClient.Event current) {
        String title = c.title() != null ? c.title().strip() : current == null ? null : current.title();
        Instant start = c.start() != null ? c.start() : current == null ? null : current.start();
        Instant end = c.end() != null ? c.end() : current == null ? null : current.end();
        if (current != null && c.start() != null && c.end() == null) {
            // Moving an event keeps its length.
            end = c.start().plus(Duration.between(current.start(), current.end()));
        }
        if (title == null || title.isBlank() || title.length() > MAX_TITLE) {
            throw new IllegalArgumentException("An event needs a title of at most " + MAX_TITLE + " characters.");
        }
        if (start == null) {
            throw new IllegalArgumentException("An event needs a start time.");
        }
        if (end == null) {
            end = start.plus(Duration.ofHours(1));
        }
        if (!end.isAfter(start) || Duration.between(start, end).compareTo(MAX_EVENT) > 0) {
            throw new IllegalArgumentException("The event must end after it starts, and last at most 14 days.");
        }
        List<Integer> reminders = c.reminderMinutes() != null ? c.reminderMinutes() : current == null ? null : current.reminderMinutes();
        if (reminders != null && (reminders.size() > 5 || reminders.stream().anyMatch(m -> m == null || m < 0 || m > 40320))) {
            throw new IllegalArgumentException("Up to 5 reminders, each 0 minutes to 4 weeks before.");
        }
        return new CalendarClient.Fields(title, start, end, reminders == null ? null : List.copyOf(reminders));
    }

    private List<EventView> conflicts(UUID userId, Instant start, Instant end, String exceptId) {
        return calendar.list(userId, start, end, 50).stream()
                .filter(e -> !e.id().equals(exceptId))
                // All-day events (holidays, birthdays) don't block a time slot.
                .filter(e -> !e.allDay())
                .filter(e -> e.start().isBefore(end) && e.end().isAfter(start))
                .map(EventView::of)
                .toList();
    }

    private static Map<String, Object> eventPayload(String eventId, CalendarClient.Fields f) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (eventId != null) {
            m.put("eventId", eventId);
        }
        m.put("title", f.title());
        m.put("start", f.start().toString());
        m.put("end", f.end().toString());
        m.put("reminderMinutes", f.reminderMinutes());
        return m;
    }

    private static CalendarClient.Fields fields(JsonNode p) {
        List<Integer> reminders = null;
        if (p.path("reminderMinutes").isArray()) {
            reminders = new ArrayList<>();
            for (JsonNode n : p.path("reminderMinutes")) {
                reminders.add(n.asInt());
            }
        }
        return new CalendarClient.Fields(p.path("title").asString(), Instant.parse(p.path("start").asString()),
                Instant.parse(p.path("end").asString()), reminders);
    }

    private static Map<String, Object> draftPayload(UUID draftId, DraftMessage m) {
        Map<String, Object> p = new LinkedHashMap<>();
        if (draftId != null) {
            p.put("draftId", draftId.toString());
        }
        p.put("to", m.to());
        p.put("subject", m.subject());
        p.put("body", m.body());
        return p;
    }

    private static DraftMessage message(JsonNode p) {
        return new DraftMessage(p.path("to").asString(), p.path("subject").asString(), p.path("body").asString());
    }

    private Instant expiry() {
        return clock.instant().plus(props.actionTtl());
    }

    private static Preview preview(GoogleActionRepository.Action a, Object before, Object after, List<EventView> conflicts) {
        return new Preview(a.id(), a.kind(), a.expiresAt(), before, after, conflicts);
    }

    private static Outcome outcome(GoogleActionRepository.Action a) {
        return new Outcome(a.id(), a.kind(), a.status(), a.result() == null ? null : JSON.readTree(a.result()));
    }

    /** The proposal can't be applied now: expired, or in progress elsewhere. */
    public static class ActionNotApplicable extends RuntimeException {
        public ActionNotApplicable(String message) {
            super(message);
        }
    }

    /** The event or draft the proposal was about is gone. The action is recorded as failed. */
    static class TargetGone extends RuntimeException {
        TargetGone(String message) {
            super(message);
        }
    }
}
