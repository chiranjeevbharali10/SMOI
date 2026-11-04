package com.smoi.calendar;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import com.smoi.google.GoogleExceptions;
import com.smoi.google.GoogleHttp;
import com.smoi.google.GoogleOAuthService;
import com.smoi.google.GoogleProperties;
import com.smoi.google.GoogleScopes;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * The only way into Google Calendar: the user's primary calendar, through the calendar.events
 * scope. Writes are only called by {@code GoogleActionService} after the user confirmed them.
 */
@Component
public class CalendarClient {

    private static final String EVENTS = "/calendars/primary/events";

    private final GoogleHttp http;
    private final GoogleOAuthService oauth;
    private final GoogleProperties props;

    public CalendarClient(GoogleHttp http, GoogleOAuthService oauth, GoogleProperties props) {
        this.http = http;
        this.oauth = oauth;
        this.props = props;
    }

    /**
     * An event. Timed events have start and end instants; all-day events have dates instead.
     *
     * @param reminderMinutes null for the calendar's default reminders
     */
    public record Event(String id, String title, Instant start, Instant end, LocalDate startDate, LocalDate endDate,
                        String htmlLink, List<Integer> reminderMinutes) {

        public boolean allDay() {
            return startDate != null;
        }
    }

    /** What SMOI may set on an event. */
    public record Fields(String title, Instant start, Instant end, List<Integer> reminderMinutes) {
    }

    /** Events overlapping [from, to), expanded (recurring events as their occurrences), by start time. */
    public List<Event> list(UUID userId, Instant from, Instant to, int max) {
        oauth.requireScope(userId, GoogleScopes.CALENDAR_EVENTS);
        GoogleHttp.Response r = http.call(userId, "GET", uri(EVENTS + "?singleEvents=true&orderBy=startTime"
                + "&maxResults=" + max + "&timeMin=" + enc(from.toString()) + "&timeMax=" + enc(to.toString())), null);
        List<Event> events = new ArrayList<>();
        for (JsonNode e : ok(r).path("items")) {
            if (!"cancelled".equals(e.path("status").asString(""))) {
                events.add(event(e));
            }
        }
        return events;
    }

    public Optional<Event> get(UUID userId, String eventId) {
        oauth.requireScope(userId, GoogleScopes.CALENDAR_EVENTS);
        GoogleHttp.Response r = http.call(userId, "GET", uri(EVENTS + "/" + safeId(eventId)), null);
        if (r.status() == 404 || r.status() == 410 || (r.ok() && "cancelled".equals(r.body().path("status").asString("")))) {
            return Optional.empty();
        }
        return Optional.of(event(ok(r)));
    }

    /**
     * Creates the event with an id SMOI chose. If an event with that id already exists (409), this
     * is a retry of a create that reached Google before, so the existing event is returned: a
     * retry can never make a second event (NFR-02.03).
     */
    public Event insert(UUID userId, String eventId, Fields f) {
        oauth.requireScope(userId, GoogleScopes.CALENDAR_EVENTS);
        Map<String, Object> body = body(f);
        body.put("id", safeId(eventId));
        GoogleHttp.Response r = http.call(userId, "POST", uri(EVENTS), body);
        if (r.status() == 409) {
            return get(userId, eventId).orElseThrow(() -> new GoogleExceptions.ApiError(409));
        }
        return event(ok(r));
    }

    /** Empty if the event no longer exists. */
    public Optional<Event> patch(UUID userId, String eventId, Fields f) {
        oauth.requireScope(userId, GoogleScopes.CALENDAR_EVENTS);
        GoogleHttp.Response r = http.call(userId, "PATCH", uri(EVENTS + "/" + safeId(eventId)), body(f));
        if (r.status() == 404 || r.status() == 410) {
            return Optional.empty();
        }
        return Optional.of(event(ok(r)));
    }

    /** Deleting an event that is already gone counts as done, so a retried delete succeeds. */
    public void delete(UUID userId, String eventId) {
        oauth.requireScope(userId, GoogleScopes.CALENDAR_EVENTS);
        GoogleHttp.Response r = http.call(userId, "DELETE", uri(EVENTS + "/" + safeId(eventId)), null);
        if (!(r.ok() || r.status() == 404 || r.status() == 410)) {
            throw new GoogleExceptions.ApiError(r.status());
        }
    }

    private static Map<String, Object> body(Fields f) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("summary", f.title());
        b.put("start", Map.of("dateTime", f.start().toString()));
        b.put("end", Map.of("dateTime", f.end().toString()));
        if (f.reminderMinutes() != null) {
            List<Map<String, Object>> overrides = f.reminderMinutes().stream()
                    .map(m -> Map.<String, Object>of("method", "popup", "minutes", m)).toList();
            b.put("reminders", Map.of("useDefault", false, "overrides", overrides));
        }
        return b;
    }

    static Event event(JsonNode e) {
        JsonNode start = e.path("start");
        JsonNode end = e.path("end");
        List<Integer> reminders = null;
        JsonNode rem = e.path("reminders");
        if (rem.isObject() && !rem.path("useDefault").asBoolean(true)) {
            reminders = new ArrayList<>();
            for (JsonNode o : rem.path("overrides")) {
                reminders.add(o.path("minutes").asInt());
            }
        }
        String title = e.path("summary").asString("(no title)");
        if (start.has("date")) {
            return new Event(e.path("id").asString(""), title, null, null,
                    LocalDate.parse(start.path("date").asString()), LocalDate.parse(end.path("date").asString()),
                    e.path("htmlLink").asString(""), reminders);
        }
        return new Event(e.path("id").asString(""), title,
                Instant.parse(normalise(start.path("dateTime").asString())), Instant.parse(normalise(end.path("dateTime").asString())),
                null, null, e.path("htmlLink").asString(""), reminders);
    }

    /** Google sends offsets ("2026-11-04T09:00:00+01:00"); Instant.parse wants Z or an offset it can read. */
    private static String normalise(String dateTime) {
        return java.time.OffsetDateTime.parse(dateTime).toInstant().toString();
    }

    /** Google event ids are base32hex characters (a-v, 0-9), 5 to 1024 long. */
    static String safeId(String id) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,1024}")) {
            throw new IllegalArgumentException("Not an event id.");
        }
        return id;
    }

    private URI uri(String pathAndQuery) {
        return URI.create(props.calendarUrl() + pathAndQuery);
    }

    private static JsonNode ok(GoogleHttp.Response r) {
        if (!r.ok() || r.body() == null) {
            throw new GoogleExceptions.ApiError(r.status());
        }
        return r.body();
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }
}
