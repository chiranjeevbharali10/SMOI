package com.smoi.google;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.smoi.actions.GoogleActionRepository;
import com.smoi.auth.CurrentUser;
import com.smoi.gmail.DraftRepository;
import com.smoi.gmail.EmailService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.util.HtmlUtils;

/**
 * Connecting and disconnecting Google (FR-04.01, FR-05.01, FR-05.12, NFR-04.01, NFR-04.04).
 *
 * <ul>
 *   <li>{@code GET /api/google}: whether Google is connected, and the scopes explained.</li>
 *   <li>{@code POST /api/google/connect}: the consent URL; the desktop opens it in the browser.</li>
 *   <li>{@code GET /api/google/callback}: where Google sends the browser back. No SMOI login here
 *       (the browser doesn't have one): the single-use {@code state} identifies the user.</li>
 *   <li>{@code POST /api/google/disconnect}: revokes access at Google and forgets the token;
 *       {@code deleteEmailData} also deletes stored emails, SMOI's record of its drafts, and SMOI
 *       Brain documents made from emails. Tasks the user made from emails are kept.</li>
 * </ul>
 */
@RestController
public class GoogleController {

    private final GoogleOAuthService oauth;
    private final GoogleAccountRepository accounts;
    private final GoogleProperties props;
    private final EmailService emails;
    private final DraftRepository drafts;
    private final GoogleActionRepository actions;

    public GoogleController(GoogleOAuthService oauth, GoogleAccountRepository accounts, GoogleProperties props,
                            EmailService emails, DraftRepository drafts, GoogleActionRepository actions) {
        this.oauth = oauth;
        this.accounts = accounts;
        this.props = props;
        this.emails = emails;
        this.drafts = drafts;
        this.actions = actions;
    }

    /**
     * @param status        not_configured, not_connected, connected or reconnect_required
     * @param grantedScopes short names of what the user allowed
     */
    public record Status(String status, String email, List<String> grantedScopes, List<GoogleScopes.Explained> scopes) {
    }

    @GetMapping("/api/google")
    public Status status(@AuthenticationPrincipal Jwt jwt) {
        if (!props.configured()) {
            return new Status("not_configured", null, List.of(), GoogleScopes.EXPLAINED);
        }
        return accounts.find(CurrentUser.id(jwt))
                .map(a -> new Status(a.status(), a.googleEmail(),
                        GoogleScopes.ALL.stream().filter(s -> GoogleScopes.has(a.scopes(), s))
                                .map(s -> s.substring(s.lastIndexOf('/') + 1)).toList(),
                        GoogleScopes.EXPLAINED))
                .orElseGet(() -> new Status("not_connected", null, List.of(), GoogleScopes.EXPLAINED));
    }

    @PostMapping("/api/google/connect")
    public Map<String, String> connect(@AuthenticationPrincipal Jwt jwt) {
        return Map.of("authorizationUrl", oauth.start(CurrentUser.id(jwt)).toString());
    }

    /** A small page for the browser tab. It never echoes anything from the request unescaped. */
    @GetMapping(value = "/api/google/callback", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> callback(@RequestParam(required = false) String state,
                                           @RequestParam(required = false) String code,
                                           @RequestParam(required = false) String error) {
        if (error != null || state == null || code == null) {
            String why = "access_denied".equals(error) ? "You didn't allow access." : "Google didn't complete the sign-in.";
            return page(400, "Not connected", why + " You can close this tab and try again from SMOI.");
        }
        try {
            oauth.complete(state, code);
            return page(200, "Connected", "SMOI is connected to your Google account. You can close this tab.");
        } catch (IllegalArgumentException e) {
            return page(400, "Not connected", e.getMessage() + " You can close this tab.");
        } catch (GoogleExceptions.Unavailable | GoogleExceptions.NotConfigured e) {
            return page(503, "Not connected", e.getMessage());
        }
    }

    public record DisconnectRequest(boolean deleteEmailData) {
    }

    /** @param revoked false if Google couldn't be reached: the token is deleted here anyway */
    public record DisconnectResult(boolean revoked, boolean emailDataDeleted) {
    }

    @PostMapping("/api/google/disconnect")
    public DisconnectResult disconnect(@AuthenticationPrincipal Jwt jwt, @RequestBody(required = false) DisconnectRequest r) {
        UUID userId = CurrentUser.id(jwt);
        boolean revoked = oauth.revokeAndForget(userId);
        actions.deletePending(userId);
        boolean delete = r != null && r.deleteEmailData();
        if (delete) {
            emails.deleteAll(userId);
            drafts.deleteAll(userId);
        }
        return new DisconnectResult(revoked, delete);
    }

    private static ResponseEntity<String> page(int status, String title, String message) {
        String html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>SMOI: " + HtmlUtils.htmlEscape(title)
                + "</title></head><body style=\"font-family:sans-serif;max-width:32rem;margin:4rem auto\"><h1>"
                + HtmlUtils.htmlEscape(title) + "</h1><p>" + HtmlUtils.htmlEscape(message) + "</p></body></html>";
        return ResponseEntity.status(status)
                .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
                .header("Cache-Control", "no-store")
                .header("Referrer-Policy", "no-referrer")
                .contentType(MediaType.TEXT_HTML)
                .body(html);
    }
}
