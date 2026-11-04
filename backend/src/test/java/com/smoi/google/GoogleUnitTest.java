package com.smoi.google;

import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import com.smoi.actions.GoogleActionServiceTestAccess;
import com.smoi.calendar.BusyRule;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Token encryption, rate-limit detection, the busy rule and event ids, without a server. */
class GoogleUnitTest {

    private static GoogleProperties props(String key) {
        return new GoogleProperties("id", "secret", key, "http://localhost/cb", "a", "t", "r", "g", "c",
                Duration.ofSeconds(5), 3, Duration.ofMillis(10), Duration.ofMinutes(30),
                new GoogleProperties.Gmail("q", 50), new GoogleProperties.Busy(6, 3, 10));
    }

    private static String newKey() {
        byte[] k = new byte[32];
        new SecureRandom().nextBytes(k);
        return Base64.getEncoder().encodeToString(k);
    }

    @Test
    void encryptsWithAFreshIvAndDecryptsOnlyForTheSameUser() {
        TokenCipher cipher = new TokenCipher(props(newKey()));
        UUID alice = UUID.randomUUID();
        byte[] a = cipher.encrypt(alice, "refresh-token-value");
        byte[] b = cipher.encrypt(alice, "refresh-token-value");

        assertThat(a).isNotEqualTo(b);
        assertThat(cipher.decrypt(alice, a)).isEqualTo("refresh-token-value");
        assertThatThrownBy(() -> cipher.decrypt(UUID.randomUUID(), a)).isInstanceOf(IllegalStateException.class);
        a[a.length - 1] ^= 1;
        assertThatThrownBy(() -> cipher.decrypt(alice, a)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void anotherKeyCannotDecrypt() {
        UUID user = UUID.randomUUID();
        byte[] ct = new TokenCipher(props(newKey())).encrypt(user, "x");
        assertThatThrownBy(() -> new TokenCipher(props(newKey())).decrypt(user, ct)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void theKeyMustBe32Bytes() {
        TokenCipher cipher = new TokenCipher(props(Base64.getEncoder().encodeToString(new byte[16])));
        assertThatThrownBy(() -> cipher.encrypt(UUID.randomUUID(), "x")).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void recognisesRateLimits() {
        JsonMapper json = JsonMapper.builder().build();
        assertThat(GoogleHttp.retryable("GET", 429, null)).isTrue();
        assertThat(GoogleHttp.retryable("GET", 503, null)).isTrue();
        assertThat(GoogleHttp.retryable("POST", 503, null)).isFalse();
        assertThat(GoogleHttp.retryable("POST", 429, null)).isTrue();
        assertThat(GoogleHttp.retryable("GET", 403, json.readTree("{\"error\":{\"errors\":[{\"reason\":\"userRateLimitExceeded\"}]}}"))).isTrue();
        assertThat(GoogleHttp.retryable("GET", 403, json.readTree("{\"error\":{\"errors\":[{\"reason\":\"forbidden\"}]}}"))).isFalse();
        assertThat(GoogleHttp.retryable("GET", 404, null)).isFalse();
    }

    @Test
    void stateNamesAUserOrNothing() {
        UUID u = UUID.randomUUID();
        assertThat(GoogleOAuthService.userOf(u + ".abc")).contains(u);
        assertThat(GoogleOAuthService.userOf("nope.abc")).isEmpty();
        assertThat(GoogleOAuthService.userOf("x".repeat(500))).isEmpty();
        assertThat(GoogleOAuthService.userOf(null)).isEmpty();
    }

    @Test
    void eventIdsAreValidForGoogleAndStable() {
        UUID action = UUID.randomUUID();
        String id = GoogleActionServiceTestAccess.eventId(action);
        assertThat(id).matches("[a-v0-9]{5,1024}").isEqualTo(GoogleActionServiceTestAccess.eventId(action));
    }

    // ---- busy rule ------------------------------------------------------------------------------

    private static BusyRule.Interval at(int startMinute, int endMinute) {
        Instant day = Instant.parse("2026-11-04T08:00:00Z");
        return new BusyRule.Interval(day.plusSeconds(startMinute * 60L), day.plusSeconds(endMinute * 60L));
    }

    @Test
    void aLightDayIsNotBusy() {
        BusyRule.Verdict v = BusyRule.judge(List.of(at(0, 60), at(180, 240)), 6, 3, 10);
        assertThat(v.busy()).isFalse();
        assertThat(v.booked()).isEqualTo(Duration.ofHours(2));
    }

    @Test
    void sixBookedHoursIsBusyAndOverlapsCountOnce() {
        assertThat(BusyRule.judge(List.of(at(0, 180), at(240, 420)), 6, 3, 10).busy()).isTrue();
        // Two parallel 4-hour blocks are 4 hours, not 8.
        BusyRule.Verdict parallel = BusyRule.judge(List.of(at(0, 240), at(0, 240)), 6, 3, 10);
        assertThat(parallel.busy()).isFalse();
        assertThat(parallel.booked()).isEqualTo(Duration.ofHours(4));
    }

    @Test
    void threeBackToBackIsBusyButGapsBreakTheRun() {
        assertThat(BusyRule.judge(List.of(at(0, 30), at(35, 60), at(65, 90)), 6, 3, 10).reason()).isEqualTo("3 meetings back to back");
        assertThat(BusyRule.judge(List.of(at(0, 30), at(45, 60), at(75, 90)), 6, 3, 10).busy()).isFalse();
        assertThat(BusyRule.judge(List.of(), 6, 3, 10).busy()).isFalse();
    }
}
