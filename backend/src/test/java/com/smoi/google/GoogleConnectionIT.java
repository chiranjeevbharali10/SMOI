package com.smoi.google;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.smoi.support.FakeGoogleServer;
import com.smoi.support.GoogleApiTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Connecting, token refresh, invalid_grant and disconnecting (FR-04.01, FR-05.12, NFR-03.03,
 * NFR-04.04), against the fake Google.
 */
class GoogleConnectionIT extends GoogleApiTest {

    private TestUser alice;

    @BeforeEach
    void user() {
        alice = newUser();
    }

    @Test
    void connectsWithPkceAndStoresOnlyAnEncryptedRefreshToken() {
        connect(alice);

        Map<String, Object> status = get(alice, "/api/google").getBody();
        assertThat(status).containsEntry("status", "connected");
        assertThat((List<Object>) status.get("grantedScopes")).containsExactlyInAnyOrder("calendar.events", "gmail.readonly", "gmail.compose");
        assertThat((List<?>) status.get("scopes")).hasSize(3);

        byte[] stored = jdbc.sql("SELECT refresh_token_encrypted FROM google_accounts WHERE user_id = :u AND deleted_at IS NULL")
                .param("u", alice.id()).query(byte[].class).single();
        assertThat(new String(stored, java.nio.charset.StandardCharsets.ISO_8859_1)).doesNotContain("refresh-");
        assertThat(stored.length).isGreaterThan(12 + 16);
    }

    @Test
    void theConsentUrlAsksOnlyForTheThreeScopes() {
        String url = (String) post(alice, "/api/google/connect", null).getBody().get("authorizationUrl");
        assertThat(query(url, "scope").split(" ")).containsExactlyInAnyOrder(
                GoogleScopes.CALENDAR_EVENTS, GoogleScopes.GMAIL_READONLY, GoogleScopes.GMAIL_COMPOSE);
        assertThat(query(url, "code_challenge")).hasSizeGreaterThan(40);
        assertThat(url).doesNotContain("code_verifier");
    }

    @Test
    void aStateWorksOnceAndOnlyForItsUser() {
        String url = (String) post(alice, "/api/google/connect", null).getBody().get("authorizationUrl");
        String state = query(url, "state");
        assertThat(callback(state, FakeGoogleServer.GOOD_CODE).getStatusCode().value()).isEqualTo(200);
        // Replayed: already used.
        assertThat(callback(state, FakeGoogleServer.GOOD_CODE).getStatusCode().value()).isEqualTo(400);
        // A state naming another user, with alice's secret, finds nothing.
        TestUser bob = newUser();
        String forged = bob.id() + state.substring(state.indexOf('.'));
        assertThat(callback(forged, FakeGoogleServer.GOOD_CODE).getStatusCode().value()).isEqualTo(400);
        assertThat(get(bob, "/api/google").getBody()).containsEntry("status", "not_connected");
    }

    @Test
    void theCallbackPageEscapesWhatItShows() {
        ResponseEntity<String> res = http().get().uri("/api/google/callback?error=<script>alert(1)</script>")
                .retrieve().toEntity(String.class);
        assertThat(res.getBody()).doesNotContain("<script>");
        assertThat(res.getHeaders().getFirst("Content-Security-Policy")).contains("default-src 'none'");
    }

    @Test
    void refreshesAnExpiredAccessTokenAndCarriesOn() {
        connect(alice);
        GOOGLE.expireAccessTokens();
        int before = GOOGLE.refreshes.get();

        ResponseEntity<Map<String, Object>> res = get(alice, "/api/calendar/upcoming?timeZone=Europe/London");

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(GOOGLE.refreshes.get()).isEqualTo(before + 1);
    }

    @Test
    void invalidGrantMarksTheAccountForReconnectionAndKeepsLocalData() {
        connect(alice);
        GOOGLE.addMessage("prof@uni.example", "Seminar moved", "The seminar is now on Friday.");
        classifyAs(r -> "{\"category\":\"academic\",\"summary\":\"The seminar moved to Friday.\"}");
        post(alice, "/api/email/sync", null);
        UUID task = UUID.randomUUID();
        http().put().uri("/api/tasks/{id}", task).header("Authorization", "Bearer " + alice.token())
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .body(Map.of("title", "Still works", "editedAt", Instant.now().toString())).retrieve().toBodilessEntity();

        // The user revokes SMOI in their Google account; the next refresh gets invalid_grant.
        GOOGLE.revokeAll();
        GOOGLE.expireAccessTokens();

        ResponseEntity<Map<String, Object>> res = get(alice, "/api/calendar/upcoming?timeZone=Europe/London");
        assertThat(res.getStatusCode().value()).isEqualTo(409);
        assertThat(res.getBody()).containsEntry("code", "google_reconnect");
        assertThat(get(alice, "/api/google").getBody()).containsEntry("status", "reconnect_required");
        // Paused, not deleted: stored mail and other features still work.
        assertThat(getList(alice, "/api/email").getBody()).hasSize(1);
        assertThat(getList(alice, "/api/tasks").getBody()).extracting(t -> t.get("title")).contains("Still works");
        // No further token calls while disconnected.
        int refreshes = GOOGLE.refreshes.get();
        assertThat(post(alice, "/api/email/sync", null).getBody()).containsEntry("code", "google_reconnect");
        assertThat(GOOGLE.refreshes.get()).isEqualTo(refreshes);

        // Reconnecting brings it back.
        connect(alice);
        assertThat(get(alice, "/api/google").getBody()).containsEntry("status", "connected");
    }

    @Test
    void disconnectRevokesTheTokenAndCanDeleteEmailData() {
        connect(alice);
        GOOGLE.addMessage("friend@example.org", "Dinner?", "Are you free on Saturday?");
        classifyAs(r -> "{\"category\":\"personal\",\"summary\":\"A friend asks about Saturday.\"}");
        post(alice, "/api/email/sync", null);
        Map<String, Object> email = getList(alice, "/api/email").getBody().getFirst();
        Map<String, Object> indexed = post(alice, "/api/email/" + email.get("id") + "/index", null).getBody();
        assertThat(indexed).containsEntry("indexed", true);
        assertThat(listDocuments(alice).getBody()).hasSize(1);

        Map<String, Object> res = post(alice, "/api/google/disconnect", Map.of("deleteEmailData", true)).getBody();

        assertThat(res).containsEntry("revoked", true).containsEntry("emailDataDeleted", true);
        assertThat(GOOGLE.revocations.get()).isEqualTo(1);
        assertThat(get(alice, "/api/google").getBody()).containsEntry("status", "not_connected");
        assertThat(getList(alice, "/api/email").getBody()).isEmpty();
        assertThat(listDocuments(alice).getBody()).isEmpty();
        // The token is gone from the database, not just hidden.
        assertThat(jdbc.sql("SELECT count(*) FROM google_accounts WHERE user_id = :u AND length(refresh_token_encrypted) > 0")
                .param("u", alice.id()).query(Long.class).single()).isZero();
    }

    @Test
    void disconnectWithoutDeletingKeepsEmails() {
        connect(alice);
        GOOGLE.addMessage("friend@example.org", "Hello", "Hi there");
        classifyAs(r -> "{\"category\":\"personal\",\"summary\":\"A greeting.\"}");
        post(alice, "/api/email/sync", null);

        post(alice, "/api/google/disconnect", Map.of("deleteEmailData", false));

        assertThat(getList(alice, "/api/email").getBody()).hasSize(1);
    }

    @Test
    void googleFeaturesSayWhenNotConnected() {
        ResponseEntity<Map<String, Object>> res = post(alice, "/api/email/sync", null);
        assertThat(res.getStatusCode().value()).isEqualTo(409);
        assertThat(res.getBody()).containsEntry("code", "google_not_connected");
    }
}
