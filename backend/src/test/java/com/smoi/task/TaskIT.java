package com.smoi.task;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.smoi.support.DocumentApiTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tasks and reminders through the real HTTP API and Postgres (FR-02.01 to FR-02.03, FR-02.06),
 * including the offline sync rule (ADR 0014) and isolation between users (NFR-03.04).
 */
class TaskIT extends DocumentApiTest {

    private TestUser alice;
    private TestUser bob;
    private final Instant t0 = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MILLIS);

    @BeforeEach
    void users() {
        alice = newUser();
        bob = newUser();
    }

    // ---- create, edit, complete, delete --------------------------------------------------

    @Test
    void createsATaskWithAllItsFields() {
        UUID id = UUID.randomUUID();
        Instant due = Instant.parse("2030-01-15T09:00:00Z");

        ResponseEntity<Map<String, Object>> res = putTask(alice, id, task("Buy pond plants", t0,
                "description", "lilies", "priority", "high", "category", "garden", "dueAt", due.toString()));

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody())
                .containsEntry("id", id.toString())
                .containsEntry("title", "Buy pond plants")
                .containsEntry("description", "lilies")
                .containsEntry("priority", "high")
                .containsEntry("category", "garden")
                .containsEntry("completedAt", null);
        assertThat(Instant.parse((String) res.getBody().get("dueAt"))).isEqualTo(due);
        assertThat(titles(alice)).containsExactly("Buy pond plants");
    }

    @Test
    void repeatingTheSameSaveIsHarmless() {
        UUID id = UUID.randomUUID();
        putTask(alice, id, task("Once", t0));
        putTask(alice, id, task("Once", t0));

        assertThat(titles(alice)).containsExactly("Once");
    }

    @Test
    void aNewerEditReplacesTheTask() {
        UUID id = UUID.randomUUID();
        putTask(alice, id, task("Old title", t0));

        ResponseEntity<Map<String, Object>> res = putTask(alice, id, task("New title", t0.plusSeconds(5)));

        assertThat(res.getBody()).containsEntry("title", "New title");
    }

    @Test
    void anOlderEditLosesAndTheNewerTaskIsReturned() {
        UUID id = UUID.randomUUID();
        putTask(alice, id, task("Edited on the laptop", t0.plusSeconds(60)));

        // A change made earlier, offline, arrives late.
        ResponseEntity<Map<String, Object>> res = putTask(alice, id, task("Edited offline earlier", t0));

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody()).containsEntry("title", "Edited on the laptop");
        assertThat(titles(alice)).containsExactly("Edited on the laptop");
    }

    @Test
    void anEditTimeInTheFutureIsCappedSoLaterEditsStillApply() {
        UUID id = UUID.randomUUID();
        putTask(alice, id, task("Clock is wrong", Instant.now().plus(365, ChronoUnit.DAYS)));

        ResponseEntity<Map<String, Object>> res = putTask(alice, id, task("Fixed", Instant.now().plusSeconds(1)));

        assertThat(res.getBody()).containsEntry("title", "Fixed");
    }

    @Test
    void completingATaskKeepsTheCompletionTime() {
        UUID id = UUID.randomUUID();
        putTask(alice, id, task("Feed the frog", t0));
        Instant done = t0.plusSeconds(30);

        Map<String, Object> body = putTask(alice, id, task("Feed the frog", t0.plusSeconds(30),
                "completedAt", done.toString())).getBody();

        assertThat(Instant.parse((String) body.get("completedAt"))).isEqualTo(done);
    }

    @Test
    void deletingATaskRemovesItAndItsReminders() {
        UUID id = UUID.randomUUID();
        putTask(alice, id, task("Short-lived", t0));
        UUID reminder = UUID.randomUUID();
        putReminder(alice, reminder, reminder("About it", t0, "taskId", id.toString()));

        assertThat(delete(alice, "/api/tasks/" + id)).isEqualTo(204);

        assertThat(titles(alice)).isEmpty();
        assertThat(list(alice, "/api/reminders")).isEmpty();
    }

    @Test
    void deletingTwiceSucceeds() {
        UUID id = UUID.randomUUID();
        putTask(alice, id, task("Gone", t0));

        assertThat(delete(alice, "/api/tasks/" + id)).isEqualTo(204);
        assertThat(delete(alice, "/api/tasks/" + id)).isEqualTo(204);
    }

    @Test
    void aDeleteWinsOverALaterEdit() {
        UUID id = UUID.randomUUID();
        putTask(alice, id, task("Deleted on one device", t0));
        delete(alice, "/api/tasks/" + id);

        ResponseEntity<Map<String, Object>> res = putTask(alice, id, task("Edited on another", Instant.now()));

        assertThat(res.getStatusCode().value()).isEqualTo(410);
        assertThat(titles(alice)).isEmpty();
    }

    @Test
    void listsOverdueTasksOnly() {
        putTask(alice, UUID.randomUUID(), task("Overdue", t0, "dueAt", t0.minus(1, ChronoUnit.DAYS).toString()));
        putTask(alice, UUID.randomUUID(), task("Done late", t0, "dueAt", t0.minus(1, ChronoUnit.DAYS).toString(),
                "completedAt", t0.toString()));
        putTask(alice, UUID.randomUUID(), task("Due later", t0, "dueAt", Instant.now().plus(1, ChronoUnit.DAYS).toString()));
        putTask(alice, UUID.randomUUID(), task("No date", t0));

        List<Map<String, Object>> overdue = list(alice, "/api/tasks?overdue=true");

        assertThat(overdue).extracting(t -> t.get("title")).containsExactly("Overdue");
    }

    @Test
    void rejectsAnInvalidTask() {
        assertThat(putTask(alice, UUID.randomUUID(), task(" ", t0)).getStatusCode().value()).isEqualTo(400);
        assertThat(putTask(alice, UUID.randomUUID(), task("x", t0, "priority", "urgent")).getStatusCode().value())
                .isEqualTo(400);
        Map<String, Object> noEditTime = task("x", t0);
        noEditTime.remove("editedAt");
        assertThat(putTask(alice, UUID.randomUUID(), noEditTime).getStatusCode().value()).isEqualTo(400);
    }

    // ---- reminders -----------------------------------------------------------------------

    @Test
    void createsRecurringReminders() {
        UUID id = UUID.randomUUID();

        ResponseEntity<Map<String, Object>> res = putReminder(alice, id, reminder("Water the plants", t0,
                "repeat", "weekdays", "weekdays", 1 | 4 | 16));

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody())
                .containsEntry("repeat", "weekdays")
                .containsEntry("weekdays", 21)
                .containsEntry("timeZone", "Europe/London");
    }

    @Test
    void rejectsAnInvalidReminder() {
        assertThat(putReminder(alice, UUID.randomUUID(), reminder("x", t0, "repeat", "weekdays")).getStatusCode().value())
                .isEqualTo(400);
        assertThat(putReminder(alice, UUID.randomUUID(), reminder("x", t0, "timeZone", "Mars/Olympus")).getStatusCode().value())
                .isEqualTo(400);
        assertThat(putReminder(alice, UUID.randomUUID(), reminder("x", t0, "repeat", "yearly")).getStatusCode().value())
                .isEqualTo(400);
    }

    @Test
    void theTimeItLastFiredOnlyMovesForward() {
        UUID id = UUID.randomUUID();
        Instant later = t0.plusSeconds(3600);
        putReminder(alice, id, reminder("Daily", t0, "repeat", "daily", "lastFiredAt", later.toString()));

        Map<String, Object> body = putReminder(alice, id, reminder("Daily", t0.plusSeconds(1), "repeat", "daily",
                "lastFiredAt", t0.toString())).getBody();

        assertThat(Instant.parse((String) body.get("lastFiredAt"))).isEqualTo(later);
    }

    // ---- sync ----------------------------------------------------------------------------

    @Test
    void syncIncludesRecentDeletionsSoDevicesCanDropThem() {
        UUID kept = UUID.randomUUID();
        UUID deleted = UUID.randomUUID();
        putTask(alice, kept, task("Kept", t0));
        putTask(alice, deleted, task("Deleted", t0));
        delete(alice, "/api/tasks/" + deleted);

        Map<String, Object> sync = get(alice, "/api/sync");

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> tasks = (List<Map<String, Object>>) sync.get("tasks");
        assertThat(tasks).hasSize(2);
        assertThat(tasks).filteredOn(t -> t.get("id").equals(deleted.toString()))
                .singleElement().satisfies(t -> assertThat(t.get("deletedAt")).isNotNull());
        assertThat(tasks).filteredOn(t -> t.get("id").equals(kept.toString()))
                .singleElement().satisfies(t -> assertThat(t.get("deletedAt")).isNull());
        assertThat(sync.get("serverTime")).isNotNull();
    }

    // ---- isolation (NFR-03.04) -----------------------------------------------------------

    @Test
    void bobCannotSeeEditOrDeleteAlicesTasks() {
        UUID id = UUID.randomUUID();
        putTask(alice, id, task("Alice's secret", t0));

        assertThat(titles(bob)).isEmpty();
        assertThat(putTask(bob, id, task("Bob was here", Instant.now())).getStatusCode().value()).isEqualTo(404);
        assertThat(delete(bob, "/api/tasks/" + id)).isEqualTo(404);
        assertThat(get(bob, "/api/sync").get("tasks")).isEqualTo(List.of());
        assertThat(titles(alice)).containsExactly("Alice's secret");
    }

    @Test
    void bobCannotAttachAReminderToAlicesTask() {
        UUID id = UUID.randomUUID();
        putTask(alice, id, task("Alice's task", t0));

        ResponseEntity<Map<String, Object>> res = putReminder(bob, UUID.randomUUID(),
                reminder("Sneaky", t0, "taskId", id.toString()));

        assertThat(res.getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void bobCannotChangeOrDeleteAlicesReminders() {
        UUID id = UUID.randomUUID();
        putReminder(alice, id, reminder("Alice's reminder", t0));

        assertThat(putReminder(bob, id, reminder("Bob's", Instant.now())).getStatusCode().value()).isEqualTo(404);
        assertThat(delete(bob, "/api/reminders/" + id)).isEqualTo(404);
        assertThat(list(bob, "/api/reminders")).isEmpty();
        assertThat(list(alice, "/api/reminders")).extracting(r -> r.get("title")).containsExactly("Alice's reminder");
    }

    @Test
    void requiresSignIn() {
        int status = http().get().uri("/api/tasks").retrieve().toBodilessEntity().getStatusCode().value();
        assertThat(status).isEqualTo(401);
    }

    // ---- helpers -------------------------------------------------------------------------

    private static Map<String, Object> task(String title, Instant editedAt, Object... more) {
        Map<String, Object> body = new HashMap<>();
        body.put("title", title);
        body.put("editedAt", editedAt.toString());
        for (int i = 0; i < more.length; i += 2) {
            body.put((String) more[i], more[i + 1]);
        }
        return body;
    }

    private static Map<String, Object> reminder(String title, Instant editedAt, Object... more) {
        Map<String, Object> body = task(title, editedAt, more);
        body.putIfAbsent("firstAt", "2030-01-15T09:00:00Z");
        body.putIfAbsent("timeZone", "Europe/London");
        return body;
    }

    private ResponseEntity<Map<String, Object>> putTask(TestUser user, UUID id, Map<String, Object> body) {
        return http().put().uri("/api/tasks/{id}", id).header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.APPLICATION_JSON).body(body).retrieve().toEntity(JSON);
    }

    private ResponseEntity<Map<String, Object>> putReminder(TestUser user, UUID id, Map<String, Object> body) {
        return http().put().uri("/api/reminders/{id}", id).header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.APPLICATION_JSON).body(body).retrieve().toEntity(JSON);
    }

    private int delete(TestUser user, String path) {
        return http().delete().uri(path).header("Authorization", "Bearer " + user.token())
                .retrieve().toBodilessEntity().getStatusCode().value();
    }

    private List<Map<String, Object>> list(TestUser user, String path) {
        return http().get().uri(path).header("Authorization", "Bearer " + user.token()).retrieve().body(JSON_LIST);
    }

    private Map<String, Object> get(TestUser user, String path) {
        return http().get().uri(path).header("Authorization", "Bearer " + user.token()).retrieve().body(JSON);
    }

    private List<Object> titles(TestUser user) {
        return list(user, "/api/tasks").stream().map(t -> t.get("title")).toList();
    }
}
