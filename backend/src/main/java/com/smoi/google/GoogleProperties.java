package com.smoi.google;

import java.time.Duration;
import java.util.Base64;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Google settings ({@code smoi.google.*}). Google features are optional: without a client id and
 * token key the rest of SMOI works, and the Google endpoints answer 503 "not configured".
 *
 * <p>The endpoint URLs are settings so integration tests can point them at a fake Google
 * server. The scopes are not: they are fixed in {@link GoogleScopes} (NFR-03.05).
 *
 * @param tokenKey     Base64 AES-256 key (32 bytes) for encrypting refresh tokens (GOOGLE_TOKEN_KEY)
 * @param redirectUri  where Google sends the browser back; must be registered in the Google Cloud console
 * @param timeout      per HTTP call to Google
 * @param maxRetries   retries after a rate limit (429, or 403 rateLimitExceeded) or a 5xx
 * @param backoffBase  first retry delay; doubled each time, with jitter, unless Google sends Retry-After
 * @param actionTtl    how long a proposed change waits for the user's confirmation
 */
@ConfigurationProperties("smoi.google")
public record GoogleProperties(String clientId, String clientSecret, String tokenKey, String redirectUri,
                               String authUrl, String tokenUrl, String revokeUrl, String gmailUrl,
                               String calendarUrl, Duration timeout, int maxRetries, Duration backoffBase,
                               Duration actionTtl, Gmail gmail, Busy busy) {

    /**
     * @param firstSyncQuery the bounded first sync (and the re-sync after the saved historyId expired)
     * @param maxResults     at most this many messages per sync
     */
    public record Gmail(String firstSyncQuery, int maxResults) {
    }

    /**
     * "Suspiciously busy": a day with at least {@code meetingHours} of events, or a run of at least
     * {@code backToBack} events with gaps under {@code gapMinutes} between them.
     */
    public record Busy(double meetingHours, int backToBack, int gapMinutes) {
    }

    public boolean configured() {
        return notBlank(clientId) && notBlank(clientSecret) && notBlank(tokenKey) && notBlank(redirectUri);
    }

    /** @throws IllegalStateException if the key is missing or not 32 bytes */
    byte[] keyBytes() {
        if (!notBlank(tokenKey)) {
            throw new IllegalStateException("GOOGLE_TOKEN_KEY is not set");
        }
        byte[] key = Base64.getDecoder().decode(tokenKey.strip());
        if (key.length != 32) {
            throw new IllegalStateException("GOOGLE_TOKEN_KEY must decode to 32 bytes (AES-256)");
        }
        return key;
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
