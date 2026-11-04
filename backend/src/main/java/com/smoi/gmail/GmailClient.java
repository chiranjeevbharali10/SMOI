package com.smoi.gmail;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import com.smoi.google.GoogleExceptions;
import com.smoi.google.GoogleHttp;
import com.smoi.google.GoogleOAuthService;
import com.smoi.google.GoogleProperties;
import com.smoi.google.GoogleScopes;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * The only way into Gmail. Every Gmail call in SMOI goes through this class (FR-05.13).
 *
 * <p><b>What it can do:</b> read the profile, list and read messages, read the change history,
 * and create, update and look up drafts.
 *
 * <p><b>What it can't do, on purpose:</b> send, delete, trash, or change labels (which includes
 * marking as read). The gmail.compose scope would let Google accept a send, so the guarantee is
 * in this code: there is no method for it, and {@code GmailSafetyTest} fails the build if one
 * appears here, or if any other class calls the Gmail API directly.
 *
 * <p>Reading uses {@code messages.get}, which never changes read/unread state; only
 * {@code messages.modify} does, and it isn't here.
 */
@Component
public class GmailClient {

    private static final String API = "/gmail/v1/users/me";

    private final GoogleHttp http;
    private final GoogleOAuthService oauth;
    private final GoogleProperties props;

    public GmailClient(GoogleHttp http, GoogleOAuthService oauth, GoogleProperties props) {
        this.http = http;
        this.oauth = oauth;
        this.props = props;
    }

    public record Profile(String emailAddress, String historyId) {
    }

    /** A message as SMOI needs it. Every text field is untrusted data from the sender. */
    public record Message(String id, String threadId, String historyId, Instant receivedAt, List<String> labelIds,
                          String from, String subject, String bodyText) {
    }

    public record DraftRef(String draftId, String messageId) {
    }

    /** The saved historyId is too old for Gmail to answer from (HTTP 404); do a full bounded sync. */
    public static class HistoryExpiredException extends RuntimeException {
        public HistoryExpiredException() {
            super("Gmail history expired");
        }
    }

    public record History(List<String> addedMessageIds, String historyId) {
    }

    // ---- reading (gmail.readonly) ---------------------------------------------------------------

    public Profile profile(UUID userId) {
        oauth.requireScope(userId, GoogleScopes.GMAIL_READONLY);
        JsonNode b = ok(get(userId, API + "/profile"));
        return new Profile(b.path("emailAddress").asString(""), b.path("historyId").asString(""));
    }

    /** Message ids matching a Gmail search, newest first, at most {@code max}. */
    public List<String> listMessageIds(UUID userId, String query, int max) {
        oauth.requireScope(userId, GoogleScopes.GMAIL_READONLY);
        JsonNode b = ok(get(userId, API + "/messages?maxResults=" + max + "&q=" + enc(query)));
        List<String> ids = new ArrayList<>();
        for (JsonNode m : b.path("messages")) {
            ids.add(m.path("id").asString());
        }
        return ids;
    }

    /** Empty if the message no longer exists. */
    public Optional<Message> message(UUID userId, String id) {
        oauth.requireScope(userId, GoogleScopes.GMAIL_READONLY);
        GoogleHttp.Response r = get(userId, API + "/messages/" + safeId(id) + "?format=full");
        if (r.status() == 404) {
            return Optional.empty();
        }
        return Optional.of(MimeText.toMessage(ok(r)));
    }

    /**
     * Messages added since {@code startHistoryId}, following pages up to {@code max} ids.
     *
     * @throws HistoryExpiredException if Gmail no longer has history that far back
     */
    public History history(UUID userId, String startHistoryId, int max) {
        oauth.requireScope(userId, GoogleScopes.GMAIL_READONLY);
        List<String> added = new ArrayList<>();
        String latest = startHistoryId;
        String page = null;
        do {
            String path = API + "/history?historyTypes=messageAdded&labelId=INBOX&startHistoryId=" + enc(startHistoryId)
                    + (page == null ? "" : "&pageToken=" + enc(page));
            GoogleHttp.Response r = get(userId, path);
            if (r.status() == 404) {
                throw new HistoryExpiredException();
            }
            JsonNode b = ok(r);
            for (JsonNode h : b.path("history")) {
                for (JsonNode a : h.path("messagesAdded")) {
                    String id = a.path("message").path("id").asString("");
                    if (!id.isEmpty() && !added.contains(id) && added.size() < max) {
                        added.add(id);
                    }
                }
            }
            latest = b.path("historyId").asString(latest);
            page = b.path("nextPageToken").asString(null);
        } while (page != null && added.size() < max);
        return new History(added, latest);
    }

    // ---- drafts (gmail.compose) -----------------------------------------------------------------

    /**
     * Creates a draft. The raw message is built by {@link DraftMessage}, which rejects header
     * injection. {@code messageId} tags it so {@link #findDraft} can recognise it after a retry.
     */
    public DraftRef createDraft(UUID userId, DraftMessage message, String messageId) {
        oauth.requireScope(userId, GoogleScopes.GMAIL_COMPOSE);
        GoogleHttp.Response r = http.call(userId, "POST", uri(API + "/drafts"),
                Map.of("message", Map.of("raw", message.raw(messageId))));
        return draftRef(ok(r));
    }

    /** The draft whose Message-ID is {@code messageId}, if there is one. */
    public Optional<DraftRef> findDraft(UUID userId, String messageId) {
        oauth.requireScope(userId, GoogleScopes.GMAIL_COMPOSE);
        JsonNode b = ok(get(userId, API + "/drafts?maxResults=5&q=" + enc("rfc822msgid:" + messageId)));
        for (JsonNode d : b.path("drafts")) {
            return Optional.of(draftRef(d));
        }
        return Optional.empty();
    }

    /** Replaces a draft's content. Empty if the draft no longer exists (sent or deleted in Gmail). */
    public Optional<DraftRef> updateDraft(UUID userId, String draftId, DraftMessage message) {
        oauth.requireScope(userId, GoogleScopes.GMAIL_COMPOSE);
        GoogleHttp.Response r = http.call(userId, "PUT", uri(API + "/drafts/" + safeId(draftId)),
                Map.of("id", draftId, "message", Map.of("raw", message.raw())));
        if (r.status() == 404) {
            return Optional.empty();
        }
        return Optional.of(draftRef(ok(r)));
    }

    /** Whether the draft still exists. A sent draft stops existing as a draft. */
    public boolean draftExists(UUID userId, String draftId) {
        oauth.requireScope(userId, GoogleScopes.GMAIL_COMPOSE);
        GoogleHttp.Response r = get(userId, API + "/drafts/" + safeId(draftId) + "?format=minimal");
        if (r.status() == 404) {
            return false;
        }
        ok(r);
        return true;
    }

    // ---- links (no API call) --------------------------------------------------------------------

    /** Opens the message in Gmail in the right account (FR-05.07). */
    public static String messageLink(String googleEmail, String messageId) {
        return "https://mail.google.com/mail/?authuser=" + enc(googleEmail) + "#all/" + safeId(messageId);
    }

    /** Opens the draft in Gmail's composer, where the user reviews and sends it. */
    public static String draftLink(String googleEmail, String messageId) {
        return "https://mail.google.com/mail/?authuser=" + enc(googleEmail) + "#drafts?compose=" + safeId(messageId);
    }

    // ---- internals ------------------------------------------------------------------------------

    private GoogleHttp.Response get(UUID userId, String pathAndQuery) {
        return http.call(userId, "GET", uri(pathAndQuery), null);
    }

    private URI uri(String pathAndQuery) {
        return URI.create(props.gmailUrl() + pathAndQuery);
    }

    private static DraftRef draftRef(JsonNode b) {
        return new DraftRef(b.path("id").asString(""), b.path("message").path("id").asString(""));
    }

    private static JsonNode ok(GoogleHttp.Response r) {
        if (!r.ok() || r.body() == null) {
            throw new GoogleExceptions.ApiError(r.status());
        }
        return r.body();
    }

    /** Gmail ids are hex-like; anything else is refused rather than put into a URL. */
    static String safeId(String id) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,64}")) {
            throw new IllegalArgumentException("Not a Gmail id.");
        }
        return id;
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }
}
