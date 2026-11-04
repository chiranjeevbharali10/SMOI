package com.smoi.calendar;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

import com.smoi.actions.GoogleActionService;
import com.smoi.google.GoogleProperties;
import org.springframework.stereotype.Service;

/** Reading the calendar: upcoming events, the busy flag, and finding an event by name (FR-04.02). */
@Service
public class CalendarService {

    static final int MAX_EVENTS = 100;

    private final CalendarClient calendar;
    private final GoogleProperties props;

    public CalendarService(CalendarClient calendar, GoogleProperties props) {
        this.calendar = calendar;
        this.props = props;
    }

    public record Upcoming(List<GoogleActionService.EventView> events, BusyRule.Verdict today) {
    }

    /** Events from now until the end of the day {@code days} ahead, and whether today is busy. */
    public Upcoming upcoming(UUID userId, int days, ZoneId zone, Instant now) {
        ZonedDateTime local = ZonedDateTime.ofInstant(now, zone);
        Instant dayStart = local.toLocalDate().atStartOfDay(zone).toInstant();
        Instant dayEnd = local.toLocalDate().plusDays(1).atStartOfDay(zone).toInstant();
        Instant until = local.toLocalDate().plusDays(days).atStartOfDay(zone).toInstant();
        List<CalendarClient.Event> events = calendar.list(userId, dayStart, until.isAfter(dayEnd) ? until : dayEnd, MAX_EVENTS);
        List<BusyRule.Interval> today = events.stream()
                .filter(e -> !e.allDay() && e.start().isBefore(dayEnd) && e.end().isAfter(dayStart))
                .map(e -> new BusyRule.Interval(e.start().isBefore(dayStart) ? dayStart : e.start(), e.end().isAfter(dayEnd) ? dayEnd : e.end()))
                .toList();
        GoogleProperties.Busy b = props.busy();
        BusyRule.Verdict verdict = BusyRule.judge(today, b.meetingHours(), b.backToBack(), b.gapMinutes());
        List<GoogleActionService.EventView> shown = events.stream()
                .filter(e -> e.allDay() ? !e.endDate().isBefore(local.toLocalDate().plusDays(1)) : e.end().isAfter(now))
                .map(GoogleActionService.EventView::of)
                .toList();
        return new Upcoming(shown, verdict);
    }

    /**
     * Events on one local day whose title contains every word of {@code query} (case-insensitive),
     * for "move my dentist appointment to 4pm". The user picks among them if there is more than one.
     */
    public List<GoogleActionService.EventView> find(UUID userId, String query, LocalDate day, ZoneId zone) {
        Instant from = day.atStartOfDay(zone).toInstant();
        Instant to = day.plusDays(1).atStartOfDay(zone).toInstant();
        String[] words = query == null ? new String[0] : query.toLowerCase(Locale.ROOT).strip().split("\\s+");
        return calendar.list(userId, from, to, MAX_EVENTS).stream()
                .filter(e -> {
                    String t = e.title().toLowerCase(Locale.ROOT);
                    for (String w : words) {
                        if (!w.isEmpty() && !t.contains(w)) {
                            return false;
                        }
                    }
                    return true;
                })
                .map(GoogleActionService.EventView::of)
                .toList();
    }
}
