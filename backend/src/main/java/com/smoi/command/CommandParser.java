package com.smoi.command;

import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;
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
 * <p>The model writes times as local date-times ("2026-11-04T17:00"); this class attaches the
 * user's time zone. Models are bad at time-zone arithmetic, and this way they don't need any.
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
        JsonNode json = firstObject(reply);
        if (json == null) {
            return Proposal.unknown(null);
        }
        Intent intent = Intent.of(text(json, "intent")).orElse(Intent.UNKNOWN);
        if (!intent.available) {
            return new Proposal(intent.id, false, null, null, null, null);
        }
        return switch (intent) {
            case CREATE_TASK -> task(json, zone);
            case CREATE_REMINDER -> reminder(json, zone, now);
            case ASK_BRAIN -> question(json);
            default -> Proposal.unknown(null);
        };
    }

    private static Proposal task(JsonNode json, ZoneId zone) {
        String title = title(json);
        if (title == null) {
            return problem(Intent.CREATE_TASK, "I couldn't tell what the task is.");
        }
        String when = text(json, "when");
        Instant due = null;
        if (when != null) {
            due = localTime(when, zone);
            if (due == null) {
                return problem(Intent.CREATE_TASK, "I couldn't work out the due date.");
            }
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
        Instant at = localTime(text(json, "when"), zone);
        if (at == null) {
            return problem(Intent.CREATE_REMINDER, "I couldn't work out when to remind you.");
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

    private static Instant localTime(String value, ZoneId zone) {
        if (value == null) {
            return null;
        }
        try {
            return ZonedDateTime.of(LocalDateTime.parse(value.strip()), zone).toInstant();
        } catch (DateTimeException e) {
            return null;
        }
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
