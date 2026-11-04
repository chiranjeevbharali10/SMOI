package com.smoi.calendar;

import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;

import com.smoi.actions.GoogleActionService;
import com.smoi.auth.CurrentUser;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Google Calendar (FR-04.02 to FR-04.06). Reads go straight to Google; every change is only a
 * proposal here, applied when the user confirms it ({@code POST /api/google/actions/{id}/confirm}).
 */
@RestController
public class CalendarController {

    private final CalendarService calendar;
    private final GoogleActionService actions;

    public CalendarController(CalendarService calendar, GoogleActionService actions) {
        this.calendar = calendar;
        this.actions = actions;
    }

    @GetMapping("/api/calendar/upcoming")
    public CalendarService.Upcoming upcoming(@AuthenticationPrincipal Jwt jwt, @RequestParam(defaultValue = "7") int days,
                                             @RequestParam String timeZone) {
        return calendar.upcoming(CurrentUser.id(jwt), Math.clamp(days, 1, 31), zone(timeZone), Instant.now());
    }

    /** Events on {@code day} whose title contains every word of {@code q}. */
    @GetMapping("/api/calendar/find")
    public List<GoogleActionService.EventView> find(@AuthenticationPrincipal Jwt jwt, @RequestParam(defaultValue = "") String q,
                                                    @RequestParam LocalDate day, @RequestParam String timeZone) {
        if (q.length() > 200) {
            throw new IllegalArgumentException("Search text is too long.");
        }
        return calendar.find(CurrentUser.id(jwt), q, day, zone(timeZone));
    }

    /** @param reminderMinutes popup reminders, minutes before (FR-04.06); null keeps the calendar's default */
    public record EventRequest(@Size(max = 300) String title, Instant start, Instant end,
                               @Size(max = 5) List<Integer> reminderMinutes) {
        GoogleActionService.EventChange change() {
            return new GoogleActionService.EventChange(title, start, end, reminderMinutes);
        }
    }

    @PostMapping("/api/calendar/events/propose")
    public GoogleActionService.Preview proposeCreate(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody EventRequest r) {
        return actions.proposeCreateEvent(CurrentUser.id(jwt), r.change());
    }

    @PostMapping("/api/calendar/events/{eventId}/propose-update")
    public GoogleActionService.Preview proposeUpdate(@AuthenticationPrincipal Jwt jwt, @PathVariable String eventId,
                                                     @Valid @RequestBody EventRequest r) {
        return actions.proposeUpdateEvent(CurrentUser.id(jwt), eventId, r.change());
    }

    @PostMapping("/api/calendar/events/{eventId}/propose-delete")
    public GoogleActionService.Preview proposeDelete(@AuthenticationPrincipal Jwt jwt, @PathVariable String eventId) {
        return actions.proposeDeleteEvent(CurrentUser.id(jwt), eventId);
    }

    /**
     * Applies a proposal (event or draft) the user confirmed. Repeating it returns the same result
     * without applying it again (NFR-02.03).
     */
    @PostMapping("/api/google/actions/{id}/confirm")
    public GoogleActionService.Outcome confirm(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return actions.confirm(CurrentUser.id(jwt), id);
    }

    private static ZoneId zone(String id) {
        try {
            return ZoneId.of(id);
        } catch (DateTimeException e) {
            throw new IllegalArgumentException("Unknown time zone: " + id);
        }
    }
}
