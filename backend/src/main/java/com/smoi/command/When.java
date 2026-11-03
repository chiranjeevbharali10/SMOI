package com.smoi.command;

import java.time.DateTimeException;
import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import tools.jackson.databind.JsonNode;

/**
 * Works out the date and time a command means, in code. The model only copies what the user said
 * into three fields; small local models get date arithmetic wrong ("tomorrow at 6 p.m." came back
 * as today at 19:00 in testing), so none is left to them.
 *
 * <ul>
 *   <li>{@code inMinutes}: "in 10 minutes" becomes now + 10 minutes;</li>
 *   <li>{@code day}: "today", "tomorrow", a weekday name ("friday": the next Friday, today
 *       included if the time is still ahead), or a date "2026-11-20";</li>
 *   <li>{@code time}: "18:00", "6pm", "6:30 p.m.", "18". A day with no time means 09:00; a time
 *       with no day means today, or tomorrow if that time has passed.</li>
 * </ul>
 * Also accepts {@code when}, a local date-time ("2026-11-04T18:00").
 */
final class When {

    sealed interface Result permits Absent, Invalid, At {
    }

    /** The command gave no time at all. */
    record Absent() implements Result {
    }

    /** It gave one that can't be understood. */
    record Invalid() implements Result {
    }

    record At(Instant instant) implements Result {
    }

    static final LocalTime DEFAULT_TIME = LocalTime.of(9, 0);
    private static final long MAX_MINUTES = Duration.ofDays(7).toMinutes();
    private static final Pattern TIME = Pattern.compile(
            "^(\\d{1,2})(?:[:.](\\d{2}))?(?::\\d{2})?\\s*(a\\.?m\\.?|p\\.?m\\.?)?$", Pattern.CASE_INSENSITIVE);
    private static final Map<String, DayOfWeek> DAYS = Map.of(
            "mon", DayOfWeek.MONDAY, "tue", DayOfWeek.TUESDAY, "wed", DayOfWeek.WEDNESDAY, "thu", DayOfWeek.THURSDAY,
            "fri", DayOfWeek.FRIDAY, "sat", DayOfWeek.SATURDAY, "sun", DayOfWeek.SUNDAY);

    private When() {
    }

    private static final Pattern DIGIT = Pattern.compile("\\d");

    /**
     * Drops date and time fields the model made up. Small models sometimes add a day or a time the
     * user never said ("call mum at 9pm" came back with "tomorrow"); the model is only meant to
     * copy what was said, so a field is kept only if the command supports it:
     * <ul>
     *   <li>{@code day}: its word ("tomorrow", "friday" or "fri", or the date) is in the command;</li>
     *   <li>{@code time} and {@code when}: the command has a digit, or says noon or midnight;</li>
     *   <li>{@code inMinutes}: the command mentions minutes or hours.</li>
     * </ul>
     */
    static JsonNode ground(JsonNode json, String command) {
        if (!(json instanceof tools.jackson.databind.node.ObjectNode original)) {
            return json;
        }
        tools.jackson.databind.node.ObjectNode o = original.deepCopy();
        String said = command.toLowerCase(Locale.ROOT);
        String day = text(o, "day");
        if (day != null) {
            String d = day.strip().toLowerCase(Locale.ROOT);
            boolean weekday = d.length() >= 3 && DAYS.containsKey(d.substring(0, 3)) && said.contains(d.substring(0, 3));
            if (!(said.contains(d) || weekday)) {
                o.remove("day");
            }
        }
        boolean saysTime = DIGIT.matcher(said).find() || said.contains("noon") || said.contains("midnight");
        if (!saysTime) {
            o.remove("time");
            o.remove("when");
        }
        if (!(said.contains("min") || said.contains("hour"))) {
            o.remove("inMinutes");
        }
        return o;
    }

    static Result resolve(JsonNode json, ZoneId zone, Instant now) {
        JsonNode minutes = json.get("inMinutes");
        if (minutes != null && minutes.isNumber()) {
            long m = minutes.asLong();
            return m >= 1 && m <= MAX_MINUTES ? new At(now.plus(Duration.ofMinutes(m))) : new Invalid();
        }
        String day = text(json, "day");
        String time = text(json, "time");
        String when = text(json, "when");
        if (day == null && time == null) {
            return when == null ? new Absent() : legacy(when, zone);
        }
        Optional<LocalTime> t = time == null ? Optional.of(DEFAULT_TIME) : parseTime(time);
        if (t.isEmpty()) {
            return new Invalid();
        }
        ZonedDateTime local = ZonedDateTime.ofInstant(now, zone);
        if (day == null) {
            ZonedDateTime today = local.with(t.get()).withSecond(0).withNano(0);
            return new At((today.toInstant().isAfter(now) ? today : today.plusDays(1)).toInstant());
        }
        return parseDay(day.strip().toLowerCase(Locale.ROOT), local, t.get(), now)
                .<Result>map(At::new).orElseGet(Invalid::new);
    }

    /** For a weekday reminder without a day: the first matching day at that time, from now on. */
    static Instant firstOnDays(int weekdays, LocalTime time, ZoneId zone, Instant now) {
        ZonedDateTime local = ZonedDateTime.ofInstant(now, zone);
        for (int i = 0; i <= 7; i++) {
            ZonedDateTime candidate = local.plusDays(i).with(time).withSecond(0).withNano(0);
            int bit = 1 << (candidate.getDayOfWeek().getValue() - 1);
            if ((weekdays & bit) != 0 && candidate.toInstant().isAfter(now)) {
                return candidate.toInstant();
            }
        }
        throw new IllegalArgumentException("no weekday set");
    }

    static Optional<LocalTime> parseTime(String s) {
        Matcher m = TIME.matcher(s.strip());
        if (!m.matches()) {
            return Optional.empty();
        }
        int hour = Integer.parseInt(m.group(1));
        int minute = m.group(2) == null ? 0 : Integer.parseInt(m.group(2));
        String ampm = m.group(3) == null ? null : m.group(3).toLowerCase(Locale.ROOT).replace(".", "");
        if (ampm != null) {
            if (hour < 1 || hour > 12) {
                return Optional.empty();
            }
            hour = hour % 12 + (ampm.equals("pm") ? 12 : 0);
        }
        return hour <= 23 && minute <= 59 ? Optional.of(LocalTime.of(hour, minute)) : Optional.empty();
    }

    private static Optional<Instant> parseDay(String day, ZonedDateTime local, LocalTime time, Instant now) {
        if (day.equals("today")) {
            return Optional.of(local.with(time).withSecond(0).withNano(0).toInstant());
        }
        if (day.equals("tomorrow")) {
            return Optional.of(local.plusDays(1).with(time).withSecond(0).withNano(0).toInstant());
        }
        DayOfWeek dow = day.length() >= 3 ? DAYS.get(day.substring(0, 3)) : null;
        if (dow != null) {
            for (int i = 0; i <= 7; i++) {
                ZonedDateTime candidate = local.plusDays(i).with(time).withSecond(0).withNano(0);
                if (candidate.getDayOfWeek() == dow && candidate.toInstant().isAfter(now)) {
                    return Optional.of(candidate.toInstant());
                }
            }
        }
        try {
            return Optional.of(ZonedDateTime.of(LocalDate.parse(day), time, local.getZone()).toInstant());
        } catch (DateTimeException e) {
            return Optional.empty();
        }
    }

    private static Result legacy(String when, ZoneId zone) {
        try {
            return new At(ZonedDateTime.of(LocalDateTime.parse(when.strip().replace(' ', 'T')), zone).toInstant());
        } catch (DateTimeException e) {
            return new Invalid();
        }
    }

    private static String text(JsonNode json, String field) {
        JsonNode v = json.get(field);
        return v != null && v.isString() && !v.asString().isBlank() ? v.asString() : null;
    }
}
