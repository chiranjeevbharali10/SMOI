package com.smoi.command;

import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Turns the model's reply into a {@link Proposal}, trusting nothing in it. The reply must be a
 * JSON object; the intent must be on the allowlist ({@link Intent}); every field is checked
 * and anything unexpected is ignored. A reply that fails these checks becomes
 * {@code unknown}, never a guess.
 *
 * <p>The model only copies the day and time the user said ("tomorrow", "18:00"); {@link When}
 * works out the actual instant in the user's time zone, in code.
 */
public final class CommandParser {

    static final int MAX_TITLE = 300;
    static final int MAX_QUESTION = 2000;
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Set<String> PRIORITIES = Set.of("low", "normal", "high");
    private static final Set<String> REPEATS = Set.of("none", "daily", "weekly", "monthly", "weekdays");
    private static final Map<String, Integer> DAYS = Map.of(
            "mon", 1, "tue", 2, "wed", 4, "thu", 8, "fri", 16, "sat", 32, "sun", 64);

    private CommandParser() {
    }

    public static Proposal parse(String reply, ZoneId zone, Instant now) {
        return parse(reply, null, zone, now);
    }

    /**
     * @param command what the user said or typed. When given, day and time fields the model
     *                filled in that aren't in the command are dropped ({@link When#ground}).
     */
    public static Proposal parse(String reply, String command, ZoneId zone, Instant now) {
        JsonNode json = firstObject(reply);
        if (json == null) {
            return Proposal.unknown(null);
        }
        if (command != null) {
            json = When.ground(json, command);
        }
        Intent intent = Intent.of(text(json, "intent")).orElse(Intent.UNKNOWN);
        if (!intent.available) {
            return new Proposal(intent.id, false, null, null, null, null);
        }
        return switch (intent) {
            case CREATE_TASK -> task(json, zone, now);
            case CREATE_REMINDER -> reminder(json, zone, now);
            case ASK_BRAIN -> question(json);
            case LIST_EVENTS -> new Proposal(Intent.LIST_EVENTS.id, true, null, null, null, null);
            case CREATE_EVENT -> createEvent(json, zone, now);
            case UPDATE_EVENT, DELETE_EVENT -> changeEvent(intent, json, zone, now);
            case DRAFT_EMAIL -> draftEmail(json, command);
            default -> Proposal.unknown(null);
        };
    }

    static final int DEFAULT_EVENT_MINUTES = 60;
    static final int MAX_EVENT_MINUTES = 24 * 60;
    static final int MAX_DRAFT_BODY = 5000;

    private static Proposal createEvent(JsonNode json, ZoneId zone, Instant now) {
        String title = title(json);
        if (title == null) {
            return problem(Intent.CREATE_EVENT, "I couldn't tell what the event is.");
        }
        if (!(When.resolve(json, zone, now) instanceof When.At at)) {
            return problem(Intent.CREATE_EVENT, "I couldn't work out when the event is.");
        }
        JsonNode d = json.get("durationMinutes");
        long minutes = d != null && d.isNumber() ? d.asLong() : DEFAULT_EVENT_MINUTES;
        if (minutes < 5 || minutes > MAX_EVENT_MINUTES) {
            minutes = DEFAULT_EVENT_MINUTES;
        }
        Instant start = at.instant();
        return new Proposal(Intent.CREATE_EVENT.id, true, null, null, null, null,
                new Proposal.EventDraft(title, start, start.plusSeconds(minutes * 60)), null, null);
    }

    /**
     * "Move the dentist to 4pm", "cancel tomorrow's team lunch". The model names the event by words
     * from its title ("event") and its day; for a move, the new day and time go in "newDay" and
     * "newTime". Matching the event is done against the real calendar later, not by the model.
     */
    private static Proposal changeEvent(Intent intent, JsonNode json, ZoneId zone, Instant now) {
        String query = text(json, "event");
        if (query == null || query.isBlank()) {
            return problem(intent, "I couldn't tell which event you mean.");
        }
        query = query.strip();
        query = query.length() > 200 ? query.substring(0, 200) : query;
        java.time.LocalDate day = java.time.ZonedDateTime.ofInstant(now, zone).toLocalDate();
        String dayText = text(json, "day");
        if (dayText != null) {
            tools.jackson.databind.node.ObjectNode probe = JSON.createObjectNode();
            probe.put("day", dayText);
            probe.put("time", "12:00");
            if (!(When.resolve(probe, zone, now) instanceof When.At at)) {
                return problem(intent, "I couldn't work out which day the event is on.");
            }
            day = java.time.ZonedDateTime.ofInstant(at.instant(), zone).toLocalDate();
        }
        if (intent == Intent.DELETE_EVENT) {
            return new Proposal(intent.id, true, null, null, null, null, null,
                    new Proposal.EventChangeDraft(query, day, null, true), null);
        }
        String newDay = text(json, "newDay");
        String newTime = text(json, "newTime");
        if (newDay == null && newTime == null) {
            return problem(intent, "I couldn't tell what to change it to.");
        }
        tools.jackson.databind.node.ObjectNode target = JSON.createObjectNode();
        target.put("day", newDay != null ? newDay : day.toString());
        if (newTime != null) {
            target.put("time", newTime);
        }
        if (!(When.resolve(target, zone, now) instanceof When.At at)) {
            return problem(intent, "I couldn't work out the new time.");
        }
        return new Proposal(intent.id, true, null, null, null, null, null,
                new Proposal.EventChangeDraft(query, day, at.instant(), false), null);
    }

    /**
     * A draft for the user to review in Gmail. The recipient must be an address that appears
     * word for word in the command: the model can't invent or swap who it goes to.
     */
    private static Proposal draftEmail(JsonNode json, String command) {
        String to = text(json, "to");
        if (to == null || to.isBlank()) {
            return problem(Intent.DRAFT_EMAIL, "Say the full email address to write to.");
        }
        to = to.strip();
        if (command != null && !command.toLowerCase(java.util.Locale.ROOT).contains(to.toLowerCase(java.util.Locale.ROOT))) {
            return problem(Intent.DRAFT_EMAIL, "Say the full email address to write to.");
        }
        try {
            String subject = Optional.ofNullable(text(json, "subject")).orElse("").strip().replaceAll("[\\r\\n]+", " ");
            String body = Optional.ofNullable(text(json, "body")).orElse("");
            body = body.length() > MAX_DRAFT_BODY ? body.substring(0, MAX_DRAFT_BODY) : body;
            com.smoi.gmail.DraftMessage m = new com.smoi.gmail.DraftMessage(to, subject.length() > 200 ? subject.substring(0, 200) : subject, body);
            return new Proposal(Intent.DRAFT_EMAIL.id, true, null, null, null, null, null, null,
                    new Proposal.EmailDraft(m.to(), m.subject(), m.body()));
        } catch (IllegalArgumentException e) {
            return problem(Intent.DRAFT_EMAIL, e.getMessage());
        }
    }

    private static Proposal task(JsonNode json, ZoneId zone, Instant now) {
        String title = title(json);
        if (title == null) {
            return problem(Intent.CREATE_TASK, "I couldn't tell what the task is.");
        }
        Instant due = null;
        When.Result when = When.resolve(json, zone, now);
        if (when instanceof When.Invalid) {
            return problem(Intent.CREATE_TASK, "I couldn't work out the due date.");
        }
        if (when instanceof When.At at) {
            due = at.instant();
        }
        String priority = text(json, "priority");
        priority = priority != null && PRIORITIES.contains(priority) ? priority : "normal";
        return new Proposal(Intent.CREATE_TASK.id, true, new Proposal.TaskDraft(title, due, priority), null, null, null);
    }

    private static Proposal reminder(JsonNode json, ZoneId zone, Instant now) {
        String title = title(json);
        if (title == null) {
            return problem(Intent.CREATE_REMINDER, "I couldn't tell what to remind you about.");
        }
        String repeat = text(json, "repeat");
        repeat = repeat != null && REPEATS.contains(repeat) ? repeat : "none";
        int weekdays = 0;
        if (repeat.equals("weekdays")) {
            weekdays = weekdays(json.get("days"));
            if (weekdays == 0) {
                return problem(Intent.CREATE_REMINDER, "I couldn't tell which days to repeat on.");
            }
        }
        Instant at;
        if (weekdays != 0 && text(json, "day") == null && text(json, "when") == null) {
            // "every Monday and Wednesday at 3pm": the first of those days, from now on.
            String time = text(json, "time");
            java.util.Optional<java.time.LocalTime> t = time == null ? java.util.Optional.of(When.DEFAULT_TIME) : When.parseTime(time);
            if (t.isEmpty()) {
                return problem(Intent.CREATE_REMINDER, "I couldn't work out when to remind you.");
            }
            at = When.firstOnDays(weekdays, t.get(), zone, now);
        } else if (When.resolve(json, zone, now) instanceof When.At a) {
            at = a.instant();
        } else {
            return problem(Intent.CREATE_REMINDER, "I couldn't work out when to remind you.");
        }
        if (repeat.equals("none") && !at.isAfter(now)) {
            return problem(Intent.CREATE_REMINDER, "That time has already passed.");
        }
        return new Proposal(Intent.CREATE_REMINDER.id, true, null,
                new Proposal.ReminderDraft(title, at, repeat, weekdays), null, null);
    }

    private static Proposal question(JsonNode json) {
        String q = text(json, "question");
        if (q == null || q.isBlank()) {
            return problem(Intent.ASK_BRAIN, "I couldn't tell what you want to ask.");
        }
        q = q.strip();
        return new Proposal(Intent.ASK_BRAIN.id, true, null, null,
                q.length() > MAX_QUESTION ? q.substring(0, MAX_QUESTION) : q, null);
    }

    private static Proposal problem(Intent intent, String message) {
        return new Proposal(intent.id, true, null, null, null, message);
    }

    /** The first {...} in the reply, so a model that wraps JSON in prose or a code fence still works. */
    static JsonNode firstObject(String reply) {
        if (reply == null) {
            return null;
        }
        int start = reply.indexOf('{');
        int end = reply.lastIndexOf('}');
        if (start < 0 || end <= start) {
            return null;
        }
        try {
            JsonNode node = JSON.readTree(reply.substring(start, end + 1));
            return node != null && node.isObject() ? node : null;
        } catch (JacksonException e) {
            return null;
        }
    }

    private static String title(JsonNode json) {
        String t = text(json, "title");
        if (t == null || t.isBlank()) {
            return null;
        }
        t = t.strip().replaceAll("\\s+", " ");
        return t.length() > MAX_TITLE ? t.substring(0, MAX_TITLE) : t;
    }

    private static int weekdays(JsonNode days) {
        if (days == null || !days.isArray()) {
            return 0;
        }
        int bits = 0;
        for (JsonNode d : days) {
            if (d.isString()) {
                String key = d.asString().strip().toLowerCase();
                bits |= DAYS.getOrDefault(key.length() >= 3 ? key.substring(0, 3) : key, 0);
            }
        }
        return bits;
    }

    private static String text(JsonNode json, String field) {
        JsonNode v = json.get(field);
        return v != null && v.isString() ? v.asString() : null;
    }

    /** For the prompt: the intents the model may choose from. */
    static List<String> intentIds() {
        return java.util.Arrays.stream(Intent.values()).map(i -> i.id).toList();
    }
}
