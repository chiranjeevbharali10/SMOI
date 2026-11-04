package com.smoi.google;

/** Errors from the Google integration. Messages are plain sentences for the user, never API bodies. */
public final class GoogleExceptions {

    private GoogleExceptions() {
    }

    /** GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_KEY or GOOGLE_REDIRECT_URI is missing. */
    public static class NotConfigured extends RuntimeException {
        public NotConfigured() {
            super("Google isn't set up on this SMOI server (see GOOGLE_* in .env.example).");
        }
    }

    /** The user hasn't connected a Google account. */
    public static class NotConnected extends RuntimeException {
        public NotConnected() {
            super("Connect your Google account first.");
        }
    }

    /**
     * Google rejected SMOI's credentials (invalid_grant: access revoked, or the refresh token
     * expired). Calendar and Gmail pause until the user reconnects; local data is kept (FR-05.12).
     */
    public static class ReconnectRequired extends RuntimeException {
        public ReconnectRequired() {
            super("Google access was revoked or has expired. Reconnect your Google account.");
        }
    }

    /** The user didn't grant the scope this feature needs. */
    public static class MissingScope extends RuntimeException {
        public MissingScope(String name) {
            super("SMOI doesn't have the " + name + " permission. Reconnect Google and allow it.");
        }
    }

    /** Google can't be reached, timed out, keeps rate-limiting, or the circuit is open (NFR-02.07). */
    public static class Unavailable extends RuntimeException {
        public Unavailable(String message) {
            super(message);
        }

        public Unavailable(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /** Google answered with an error SMOI doesn't handle. Only the status is kept, never the body. */
    public static class ApiError extends RuntimeException {
        public final int status;

        public ApiError(int status) {
            super("Google returned an error (HTTP " + status + ").");
            this.status = status;
        }
    }
}
