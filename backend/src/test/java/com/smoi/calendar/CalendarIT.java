package com.smoi.calendar;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import com.smoi.support.GoogleApiTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Calendar through the real API against the fake Google (FR-04.02 to FR-04.06, NFR-02.03):
 * proposals change nothing, conflicts are listed, and confirming is idempotent.
 */
class CalendarIT extends GoogleApiTest {

    private TestUser alice;
    private final Instant tenAm = Instant.now().plus(2, ChronoUnit.DAYS).truncatedTo(ChronoUnit.HOURS);

    @BeforeEach
    void user() {
        alice = newUser();
        connect(alice);
    }

    @Test
    void listsUpcomingEvents() {
        GOOGLE.addEvent("ev1", "Dentist", tenAm.toString(), tenAm.plus(1, ChronoUnit.HOURS).toString());

        Map<String, Object> res = get(alice, "/api/calendar/upcoming?timeZone=UTC&days=7").getBody();

        assertThat((List<Map<String, Object>>) res.get("events")).extracting(e -> e.get("title")).containsExactly("Dentist");
        assertThat(((Map<String, Object>) res.get("today")).get("busy")).isEqualTo(false);
    }

    @Test
    void aProposalChangesNothingAndListsConflicts() {
        GOOGLE.addEvent("ev1", "Standup", tenAm.toString(), tenAm.plus(1, ChronoUnit.HOURS).toString());
        GOOGLE.addEvent("ev2", "Later", tenAm.plus(3, ChronoUnit.HOURS).toString(), tenAm.plus(4, ChronoUnit.HOURS).toString());

        Map<String, Object> preview = post(alice, "/api/calendar/events/propose", Map.of(
                "title", "Pairing", "start", tenAm.plus(30, ChronoUnit.MINUTES).toString(),
                "end", tenAm.plus(90, ChronoUnit.MINUTES).toString(), "reminderMinutes", List.of(10))).getBody();

        assertThat(preview).containsEntry("kind", "create_event");
        assertThat((List<Map<String, Object>>) preview.get("conflicts")).extracting(c -> c.get("title")).containsExactly("Standup");
        assertThat(GOOGLE.events()).hasSize(2);
        assertThat(GOOGLE.requests()).noneMatch(r -> r.method().equals("POST") && r.path().contains("/events"));
    }

    @Test
    void confirmingTwiceCreatesOneEvent() {
        String id = proposeCreate("Lunch");

        Map<String, Object> first = post(alice, "/api/google/actions/" + id + "/confirm", null).getBody();
        Map<String, Object> second = post(alice, "/api/google/actions/" + id + "/confirm", null).getBody();

        assertThat(first).containsEntry("status", "applied");
        assertThat(second).isEqualTo(first);
        assertThat(GOOGLE.events()).hasSize(1);
        Map<String, Object> event = GOOGLE.events().values().iterator().next();
        assertThat(event.get("summary")).isEqualTo("Lunch");
        assertThat(event.get("reminders").toString()).contains("minutes=10");
    }

    @Test
    void aRetryAfterALostResponseDoesNotDuplicate() {
        String id = proposeCreate("Retry me");
        // Google creates the event, but the answer never arrives.
        GOOGLE.applyThenFail("POST /calendar/v3/calendars/primary/events");

        ResponseEntity<Map<String, Object>> first = post(alice, "/api/google/actions/" + id + "/confirm", null);
        assertThat(first.getStatusCode().value()).isEqualTo(503);
        assertThat(GOOGLE.events()).hasSize(1);

        // The user confirms again: Google answers 409 for the id it already has, and SMOI reads that event back.
        Map<String, Object> retry = post(alice, "/api/google/actions/" + id + "/confirm", null).getBody();
        assertThat(retry).containsEntry("status", "applied");
        assertThat(GOOGLE.events()).hasSize(1);
        assertThat(post(alice, "/api/google/actions/" + id + "/confirm", null).getBody()).isEqualTo(retry);
    }

    @Test
    void concurrentConfirmsApplyOnce() {
        String id = proposeCreate("Race");
        List<CompletableFuture<Integer>> calls = java.util.stream.IntStream.range(0, 6)
                .mapToObj(i -> CompletableFuture.supplyAsync(() ->
                        post(alice, "/api/google/actions/" + id + "/confirm", null).getStatusCode().value()))
                .toList();
        List<Integer> statuses = calls.stream().map(CompletableFuture::join).toList();

        assertThat(statuses).contains(200).allMatch(s -> s == 200 || s == 409);
        assertThat(GOOGLE.events()).hasSize(1);
    }

    @Test
    void updateShowsBeforeAndAfterAndAppliesOnlyOnConfirm() {
        GOOGLE.addEvent("ev9", "Dentist", tenAm.toString(), tenAm.plus(1, ChronoUnit.HOURS).toString());
        Instant newStart = tenAm.plus(6, ChronoUnit.HOURS);

        Map<String, Object> preview = post(alice, "/api/calendar/events/ev9/propose-update", Map.of("start", newStart.toString())).getBody();

        assertThat(((Map<String, Object>) preview.get("before")).get("title")).isEqualTo("Dentist");
        // Moving keeps the length.
        assertThat(((Map<String, Object>) preview.get("after")).get("end")).isEqualTo(newStart.plus(1, ChronoUnit.HOURS).toString());
        assertThat(GOOGLE.events().get("ev9").get("start").toString()).contains(tenAm.toString().substring(0, 13));

        post(alice, "/api/google/actions/" + preview.get("id") + "/confirm", null);
        assertThat(GOOGLE.events().get("ev9").get("start").toString()).contains(newStart.toString().substring(0, 13));
    }

    @Test
    void deleteIsAppliedOnceAndARetryIsHarmless() {
        GOOGLE.addEvent("ev7", "Cancel me", tenAm.toString(), tenAm.plus(1, ChronoUnit.HOURS).toString());
        Object id = post(alice, "/api/calendar/events/ev7/propose-delete", null).getBody().get("id");
        assertThat(GOOGLE.events()).containsKey("ev7");

        post(alice, "/api/google/actions/" + id + "/confirm", null);
        Map<String, Object> again = post(alice, "/api/google/actions/" + id + "/confirm", null).getBody();

        assertThat(again).containsEntry("status", "applied");
        assertThat(GOOGLE.events()).doesNotContainKey("ev7");
        assertThat(GOOGLE.requests().stream().filter(r -> r.method().equals("DELETE"))).hasSize(1);
    }

    @Test
    void anotherUserCannotConfirmMyProposal() {
        String id = proposeCreate("Mine");
        TestUser bob = newUser();

        assertThat(post(bob, "/api/google/actions/" + id + "/confirm", null).getStatusCode().value()).isEqualTo(404);
        assertThat(GOOGLE.events()).isEmpty();
    }

    @Test
    void rejectsAnEventThatEndsBeforeItStarts() {
        ResponseEntity<Map<String, Object>> res = post(alice, "/api/calendar/events/propose", Map.of(
                "title", "Backwards", "start", tenAm.toString(), "end", tenAm.minusSeconds(60).toString()));
        assertThat(res.getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void backsOffOnRateLimitsThenSucceeds() {
        GOOGLE.failNext("GET /calendar/v3/calendars/primary/events", 429, 2);

        assertThat(get(alice, "/api/calendar/upcoming?timeZone=UTC").getStatusCode().value()).isEqualTo(200);
        assertThat(GOOGLE.requests().stream().filter(r -> r.path().endsWith("/events"))).hasSize(3);
    }

    @Test
    void givesUpWithAClearErrorWhenRateLimitsPersist() {
        GOOGLE.failNext("GET /calendar/v3/calendars/primary/events", 403, 100);

        ResponseEntity<Map<String, Object>> res = get(alice, "/api/calendar/upcoming?timeZone=UTC");

        assertThat(res.getStatusCode().value()).isEqualTo(503);
        assertThat(res.getBody()).containsEntry("code", "google_unavailable");
        // One try plus three retries.
        assertThat(GOOGLE.requests().stream().filter(r -> r.path().endsWith("/events"))).hasSize(4);
    }

    private String proposeCreate(String title) {
        Map<String, Object> preview = post(alice, "/api/calendar/events/propose", Map.of(
                "title", title, "start", tenAm.toString(), "end", tenAm.plus(1, ChronoUnit.HOURS).toString(),
                "reminderMinutes", List.of(10))).getBody();
        return (String) preview.get("id");
    }
}
