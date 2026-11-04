package com.smoi.google;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Connecting a Google account and keeping a usable access token (FR-04.01, FR-05.01, FR-05.12).
 *
 * <h2>Connecting: authorization code flow with PKCE</h2>
 * <ol>
 *   <li>{@link #start}: a random {@code state} ("userId.secret") and PKCE code verifier are made.
 *       Only the state's SHA-256 is stored, with the verifier, for 10 minutes. The desktop opens
 *       Google's consent page in the browser.</li>
 *   <li>Google redirects the browser to {@code /api/google/callback?state&code}. {@link #complete}
 *       uses up the state (once only) and swaps the code plus the verifier for tokens. PKCE means an
 *       intercepted code is useless without the verifier, which never left the server.</li>
 *   <li>The refresh token is encrypted ({@link TokenCipher}) and stored. The access token lives in
 *       memory only, and is refreshed shortly before it expires.</li>
 * </ol>
 *
 * <h2>When Google says no</h2>
 * A refresh answered with {@code invalid_grant} means access was revoked or the token expired. The
 * account is marked {@code reconnect_required}, Calendar and Gmail calls stop with
 * {@link GoogleExceptions.ReconnectRequired}, and every local row is kept.
 *
 * <p>Tokens and codes are never logged.
 */
@Service
public class GoogleOAuthService {

    private static final Logger log = LoggerFactory.getLogger(GoogleOAuthService.class);
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Duration STATE_TTL = Duration.ofMinutes(10);
    /** Refresh this long before Google's expiry, so a token never expires mid-call. */
    private static final Duration EXPIRY_MARGIN = Duration.ofMinutes(2);

    private final GoogleProperties props;
    private final GoogleAccountRepository accounts;
    private final TokenCipher cipher;
    private final HttpClient http;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();
    private final Map<UUID, AccessToken> cache = new ConcurrentHashMap<>();

    private record AccessToken(String value, Instant expiresAt) {
    }

    @Autowired
    public GoogleOAuthService(GoogleProperties props, GoogleAccountRepository accounts, TokenCipher cipher) {
        this(props, accounts, cipher, Clock.systemUTC());
    }

    GoogleOAuthService(GoogleProperties props, GoogleAccountRepository accounts, TokenCipher cipher, Clock clock) {
        this.props = props;
        this.accounts = accounts;
        this.cipher = cipher;
        this.clock = clock;
        this.http = HttpClient.newBuilder().connectTimeout(props.timeout()).followRedirects(HttpClient.Redirect.NEVER).build();
    }

    // ---- connecting -----------------------------------------------------------------------------

    /** Returns Google's consent URL for this user. */
    public URI start(UUID userId) {
        requireConfigured();
        String state = userId + "." + randomToken(32);
        String verifier = randomToken(48);
        accounts.saveState(userId, sha256Hex(state), verifier, clock.instant().plus(STATE_TTL));
        Map<String, String> q = new LinkedHashMap<>();
        q.put("client_id", props.clientId());
        q.put("redirect_uri", props.redirectUri());
        q.put("response_type", "code");
        q.put("scope", String.join(" ", GoogleScopes.ALL));
        // offline + consent: Google returns a refresh token, also when reconnecting.
        q.put("access_type", "offline");
        q.put("prompt", "consent");
        q.put("state", state);
        q.put("code_challenge", base64Url(sha256(verifier.getBytes(StandardCharsets.US_ASCII))));
        q.put("code_challenge_method", "S256");
        return URI.create(props.authUrl() + "?" + form(q));
    }

    /**
     * Finishes connecting after Google's redirect.
     *
     * @return the user who connected
     * @throws IllegalArgumentException if the state is unknown, used, expired or malformed
     */
    public UUID complete(String state, String code) {
        requireConfigured();
        UUID userId = userOf(state).orElseThrow(() -> new IllegalArgumentException("This sign-in link is invalid or has expired."));
        String verifier = accounts.consumeState(userId, sha256Hex(state))
                .orElseThrow(() -> new IllegalArgumentException("This sign-in link is invalid or has expired."));
        Map<String, String> body = new LinkedHashMap<>();
        body.put("grant_type", "authorization_code");
        body.put("code", code);
        body.put("redirect_uri", props.redirectUri());
        body.put("client_id", props.clientId());
        body.put("client_secret", props.clientSecret());
        body.put("code_verifier", verifier);
        JsonNode tokens = postToken(body, userId, false);
        String refresh = text(tokens, "refresh_token");
        if (refresh == null) {
            throw new GoogleExceptions.Unavailable("Google didn't return a refresh token. Try connecting again.");
        }
        String scopes = Optional.ofNullable(text(tokens, "scope")).orElse("");
        accounts.save(userId, "", cipher.encrypt(userId, refresh), scopes);
        cacheToken(userId, tokens);
        return userId;
    }

    // ---- access tokens --------------------------------------------------------------------------

    /**
     * A valid access token for the user's connected account.
     *
     * @throws GoogleExceptions.NotConnected      no account
     * @throws GoogleExceptions.ReconnectRequired Google rejected the refresh token, now or earlier
     * @throws GoogleExceptions.Unavailable       Google couldn't be reached
     */
    public String accessToken(UUID userId) {
        requireConfigured();
        GoogleAccountRepository.Account account = connectedAccount(userId);
        AccessToken cached = cache.get(userId);
        if (cached != null && clock.instant().isBefore(cached.expiresAt().minus(EXPIRY_MARGIN))) {
            return cached.value();
        }
        Map<String, String> body = new LinkedHashMap<>();
        body.put("grant_type", "refresh_token");
        body.put("refresh_token", cipher.decrypt(userId, account.refreshTokenEncrypted()));
        body.put("client_id", props.clientId());
        body.put("client_secret", props.clientSecret());
        return cacheToken(userId, postToken(body, userId, true));
    }

    /** Forget the cached access token, for example after Google answered 401. */
    public void invalidate(UUID userId) {
        cache.remove(userId);
    }

    /**
     * @throws GoogleExceptions.NotConnected      no account
     * @throws GoogleExceptions.ReconnectRequired the account needs reconnecting
     */
    public GoogleAccountRepository.Account connectedAccount(UUID userId) {
        GoogleAccountRepository.Account account = accounts.find(userId).orElseThrow(GoogleExceptions.NotConnected::new);
        if (!account.connected()) {
            throw new GoogleExceptions.ReconnectRequired();
        }
        return account;
    }

    /** @throws GoogleExceptions.MissingScope if the user didn't grant it */
    public void requireScope(UUID userId, String scope) {
        if (!GoogleScopes.has(connectedAccount(userId).scopes(), scope)) {
            throw new GoogleExceptions.MissingScope(scope.substring(scope.lastIndexOf('/') + 1));
        }
    }

    // ---- disconnecting --------------------------------------------------------------------------

    /**
     * Revokes the refresh token at Google and forgets it. Returns whether Google confirmed the
     * revocation; if it couldn't be reached, the token is still deleted here, and the user is told
     * to remove access in their Google account.
     */
    public boolean revokeAndForget(UUID userId) {
        Optional<GoogleAccountRepository.Account> account = accounts.find(userId);
        boolean revoked = false;
        if (account.isPresent() && props.configured()) {
            try {
                String token = cipher.decrypt(userId, account.get().refreshTokenEncrypted());
                HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create(props.revokeUrl()))
                                .timeout(props.timeout())
                                .header("Content-Type", "application/x-www-form-urlencoded")
                                .POST(HttpRequest.BodyPublishers.ofString(form(Map.of("token", token))))
                                .build(),
                        HttpResponse.BodyHandlers.ofString());
                // 400 means Google no longer knows the token: it is already unusable.
                revoked = res.statusCode() == 200 || res.statusCode() == 400;
                if (!revoked) {
                    log.warn("Google revoke returned HTTP {}", res.statusCode());
                }
            } catch (IOException | RuntimeException e) {
                log.warn("Google revoke failed: {}", e.getClass().getSimpleName());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        accounts.delete(userId);
        cache.remove(userId);
        return revoked;
    }

    // ---- internals ------------------------------------------------------------------------------

    private JsonNode postToken(Map<String, String> form, UUID userId, boolean refreshing) {
        HttpResponse<String> res;
        try {
            res = http.send(HttpRequest.newBuilder(URI.create(props.tokenUrl()))
                            .timeout(props.timeout())
                            .header("Content-Type", "application/x-www-form-urlencoded")
                            .POST(HttpRequest.BodyPublishers.ofString(form(form)))
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
        } catch (IOException e) {
            throw new GoogleExceptions.Unavailable("Google sign-in couldn't be reached.", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new GoogleExceptions.Unavailable("Interrupted while contacting Google.", e);
        }
        JsonNode body = parse(res.body());
        if (res.statusCode() == 200 && body != null) {
            return body;
        }
        String error = body == null ? null : text(body, "error");
        if (refreshing && "invalid_grant".equals(error)) {
            log.warn("Google rejected the refresh token (invalid_grant); marking the account for reconnection");
            accounts.markReconnectRequired(userId);
            cache.remove(userId);
            throw new GoogleExceptions.ReconnectRequired();
        }
        if (!refreshing && res.statusCode() == 400) {
            throw new IllegalArgumentException("Google didn't accept this sign-in. Try connecting again.");
        }
        log.warn("Google token endpoint returned HTTP {} ({})", res.statusCode(), error == null ? "no error code" : error);
        throw new GoogleExceptions.Unavailable("Google sign-in failed (HTTP " + res.statusCode() + ").");
    }

    private String cacheToken(UUID userId, JsonNode tokens) {
        String access = text(tokens, "access_token");
        if (access == null) {
            throw new GoogleExceptions.Unavailable("Google didn't return an access token.");
        }
        JsonNode expires = tokens.get("expires_in");
        long seconds = expires != null && expires.isNumber() ? expires.asLong() : 3600;
        cache.put(userId, new AccessToken(access, clock.instant().plusSeconds(seconds)));
        return access;
    }

    private void requireConfigured() {
        if (!props.configured()) {
            throw new GoogleExceptions.NotConfigured();
        }
    }

    static Optional<UUID> userOf(String state) {
        if (state == null || state.length() > 200) {
            return Optional.empty();
        }
        int dot = state.indexOf('.');
        if (dot <= 0) {
            return Optional.empty();
        }
        try {
            return Optional.of(UUID.fromString(state.substring(0, dot)));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    private String randomToken(int bytes) {
        byte[] b = new byte[bytes];
        random.nextBytes(b);
        return base64Url(b);
    }

    private static String base64Url(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    static byte[] sha256(byte[] in) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(in);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static String sha256Hex(String s) {
        return HexFormat.of().formatHex(sha256(s.getBytes(StandardCharsets.UTF_8)));
    }

    static String form(Map<String, String> fields) {
        return fields.entrySet().stream()
                .map(e -> URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8) + "=" + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                .collect(Collectors.joining("&"));
    }

    private static JsonNode parse(String body) {
        try {
            return body == null || body.isBlank() ? null : JSON.readTree(body);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v != null && v.isString() ? v.asString() : null;
    }
}
