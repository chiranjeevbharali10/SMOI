package com.smoi.google;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

import com.smoi.resilience.ProviderCircuitBreakers;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Authorised JSON calls to Google's APIs, used only by {@code GmailClient} and
 * {@code CalendarClient}.
 *
 * <ul>
 *   <li><b>401</b>: the access token was rejected; it is refreshed once and the call repeated.</li>
 *   <li><b>Rate limits</b> (429, or 403 with reason rateLimitExceeded or userRateLimitExceeded), and
 *       <b>5xx</b> on anything but POST: retried up to {@code maxRetries} times, waiting Retry-After if Google sent it,
 *       otherwise backoffBase x 2^attempt with up to 50% random jitter, so many clients don't
 *       retry in step. After that the call fails as {@link GoogleExceptions.Unavailable}.</li>
 *   <li>Network errors and timeouts count towards the "google" circuit breaker (NFR-02.07).</li>
 *   <li>Logs carry the method, the path and the status only: never a query string (it can hold
 *       a search), a request or response body, or a token.</li>
 * </ul>
 * A POST that got a 5xx is not retried here: Google may have acted before failing, and only the
 * caller knows how to check (GoogleActionService). A rate-limited request wasn't processed, so it
 * is always safe to repeat.
 *
 * <p>Other statuses (404, 409, 410...) are returned for the caller to interpret.
 */
@Component
public class GoogleHttp {

    private static final Logger log = LoggerFactory.getLogger(GoogleHttp.class);
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Duration MAX_WAIT = Duration.ofSeconds(30);

    public record Response(int status, JsonNode body) {
        public boolean ok() {
            return status >= 200 && status < 300;
        }
    }

    private final GoogleOAuthService oauth;
    private final GoogleProperties props;
    private final ProviderCircuitBreakers breakers;
    private final HttpClient http;

    public GoogleHttp(GoogleOAuthService oauth, GoogleProperties props, ProviderCircuitBreakers breakers) {
        this.oauth = oauth;
        this.props = props;
        this.breakers = breakers;
        this.http = HttpClient.newBuilder().connectTimeout(props.timeout()).followRedirects(HttpClient.Redirect.NEVER).build();
    }

    /** @param jsonBody null for no body */
    public Response call(UUID userId, String method, URI uri, Object jsonBody) {
        String body = jsonBody == null ? null : JSON.writeValueAsString(jsonBody);
        return breakers.google(() -> withRetries(userId, method, uri, body));
    }

    private Response withRetries(UUID userId, String method, URI uri, String body) {
        boolean refreshed = false;
        for (int attempt = 0; ; attempt++) {
            HttpResponse<String> res = send(oauth.accessToken(userId), method, uri, body);
            int status = res.statusCode();
            if (status == 401 && !refreshed) {
                oauth.invalidate(userId);
                refreshed = true;
                attempt--;
                continue;
            }
            JsonNode json = parse(res.body());
            if (retryable(method, status, json)) {
                if (attempt >= props.maxRetries()) {
                    log.warn("Google {} {} still failing after {} retries (HTTP {})", method, uri.getPath(), attempt, status);
                    throw new GoogleExceptions.Unavailable(status == 429 || status == 403
                            ? "Google is rate-limiting SMOI. Try again in a minute."
                            : "Google is having problems. Try again later.");
                }
                sleep(delay(attempt, res));
                continue;
            }
            if (status >= 500) {
                // A POST that failed this way isn't retried here (see the class comment).
                log.warn("Google {} {} answered HTTP {}", method, uri.getPath(), status);
                throw new GoogleExceptions.Unavailable("Google is having problems. Try again later.");
            }
            if (status >= 400) {
                log.info("Google {} {} answered HTTP {}", method, uri.getPath(), status);
            }
            return new Response(status, json);
        }
    }

    private HttpResponse<String> send(String token, String method, URI uri, String body) {
        HttpRequest.Builder b = HttpRequest.newBuilder(uri)
                .timeout(props.timeout())
                .header("Authorization", "Bearer " + token)
                .header("Accept", "application/json");
        if (body != null) {
            b.header("Content-Type", "application/json");
        }
        b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        try {
            return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
        } catch (HttpTimeoutException e) {
            throw new GoogleExceptions.Unavailable("Google didn't answer in time.", e);
        } catch (IOException e) {
            throw new GoogleExceptions.Unavailable("Google couldn't be reached.", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new GoogleExceptions.Unavailable("Interrupted while contacting Google.", e);
        }
    }

    static boolean retryable(String method, int status, JsonNode body) {
        if (status == 429) {
            return true;
        }
        if (status >= 500) {
            return !method.equals("POST");
        }
        if (status != 403 || body == null) {
            return false;
        }
        // Google signals some rate limits as 403 with a reason in error.errors[].reason.
        JsonNode errors = body.path("error").path("errors");
        for (JsonNode e : errors) {
            String reason = e.path("reason").asString("");
            if (reason.equals("rateLimitExceeded") || reason.equals("userRateLimitExceeded")) {
                return true;
            }
        }
        return false;
    }

    private Duration delay(int attempt, HttpResponse<String> res) {
        String retryAfter = res.headers().firstValue("Retry-After").orElse(null);
        if (retryAfter != null && retryAfter.matches("\\d{1,4}")) {
            Duration d = Duration.ofSeconds(Long.parseLong(retryAfter));
            return d.compareTo(MAX_WAIT) > 0 ? MAX_WAIT : d;
        }
        long base = props.backoffBase().toMillis() << Math.min(attempt, 10);
        long jitter = ThreadLocalRandom.current().nextLong(base / 2 + 1);
        return Duration.ofMillis(Math.min(base + jitter, MAX_WAIT.toMillis()));
    }

    private static void sleep(Duration d) {
        try {
            Thread.sleep(d);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new GoogleExceptions.Unavailable("Interrupted while waiting to retry Google.", e);
        }
    }

    private static JsonNode parse(String body) {
        try {
            return body == null || body.isBlank() ? null : JSON.readTree(body);
        } catch (RuntimeException e) {
            return null;
        }
    }
}
