package com.smoi.support;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * A stand-in for Google in integration tests: the OAuth token and revoke endpoints, the parts of
 * the Gmail API SMOI uses, and Calendar events. In-memory and deterministic. Every request is
 * recorded ({@link #requests()}), so tests can check what SMOI did and did not call.
 *
 * <p>Only synthetic data: no real email, account or token is ever used in tests.
 *
 * <p>Failure switches: {@link #failNext} answers the next matching requests with a status (429,
 * 503...); {@link #applyThenFail} performs the next matching write and then answers 503, like a
 * response lost after Google acted; {@link #revokeAll} makes refresh tokens invalid (invalid_grant);
 * {@link #expireAccessTokens} makes current access tokens answer 401.
 */
public final class FakeGoogleServer {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    public static final String GOOD_CODE = "test-auth-code";
    public static final String ACCOUNT = "frog.tester@example.com";

    public record Request(String method, String path, String query) {
    }

    private final HttpServer server;
    private final List<Request> requests = new CopyOnWriteArrayList<>();
    private final Set<String> validAccess = ConcurrentHashMap.newKeySet();
    private final Set<String> validRefresh = ConcurrentHashMap.newKeySet();
    private final AtomicInteger counter = new AtomicInteger();
    public final AtomicInteger refreshes = new AtomicInteger();
    public final AtomicInteger revocations = new AtomicInteger();
    private final Map<String, Failure> failures = new ConcurrentHashMap<>();
    private final Set<String> applyThenFail = ConcurrentHashMap.newKeySet();

    /** Gmail: messages by id, with the history id at which each was added. */
    private final Map<String, Map<String, Object>> messages = Collections.synchronizedMap(new LinkedHashMap<>());
    private final Map<String, Long> messageHistory = new ConcurrentHashMap<>();
    private volatile long historyId = 1000;
    /** History older than this is "expired": history.list answers 404. */
    private volatile long oldestHistory = 0;
    /** Drafts by id: {id, messageId, raw}. */
    private final Map<String, Map<String, String>> drafts = new ConcurrentHashMap<>();
    /** Calendar events by id. */
    private final Map<String, Map<String, Object>> events = Collections.synchronizedMap(new LinkedHashMap<>());

    private record Failure(int status, AtomicInteger remaining) {
    }

    public FakeGoogleServer() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        server.createContext("/", this::handle);
        server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(8));
        server.start();
    }

    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    // ---- test controls --------------------------------------------------------------------------

    public synchronized void reset() {
        requests.clear();
        validAccess.clear();
        validRefresh.clear();
        refreshes.set(0);
        revocations.set(0);
        failures.clear();
        applyThenFail.clear();
        messages.clear();
        messageHistory.clear();
        historyId = 1000;
        oldestHistory = 0;
        drafts.clear();
        events.clear();
    }

    public List<Request> requests() {
        return List.copyOf(requests);
    }

    /** Answers the next {@code times} requests whose "METHOD path" starts with {@code prefix} with {@code status}. */
    public void failNext(String prefix, int status, int times) {
        failures.put(prefix, new Failure(status, new AtomicInteger(times)));
    }

    /** The next write matching "METHOD path" prefix is performed, but answered 503. */
    public void applyThenFail(String prefix) {
        applyThenFail.add(prefix);
    }

    public void revokeAll() {
        validRefresh.clear();
    }

    public void expireAccessTokens() {
        validAccess.clear();
    }

    /** Adds an unread primary inbox message (synthetic). */
    public synchronized String addMessage(String from, String subject, String body, String... extraLabels) {
        String id = "msg" + counter.incrementAndGet();
        historyId += 10;
        List<String> labels = new ArrayList<>(List.of("UNREAD", "INBOX"));
        labels.addAll(List.of(extraLabels));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("threadId", "thr" + id);
        m.put("historyId", String.valueOf(historyId));
        m.put("internalDate", String.valueOf(System.currentTimeMillis()));
        m.put("labelIds", labels);
        m.put("payload", Map.of(
                "mimeType", "multipart/alternative",
                "headers", List.of(Map.of("name", "From", "value", from), Map.of("name", "Subject", "value", subject)),
                "parts", List.of(Map.of("mimeType", "text/plain", "body",
                        Map.of("data", Base64.getUrlEncoder().encodeToString(body.getBytes(StandardCharsets.UTF_8)))))));
        messages.put(id, m);
        messageHistory.put(id, historyId);
        return id;
    }

    /** Gmail forgets history before now: the next history.list from an older id gets 404. */
    public synchronized void expireHistory() {
        historyId += 10;
        oldestHistory = historyId;
    }

    public Map<String, Map<String, Object>> events() {
        return events;
    }

    public void addEvent(String id, String title, String start, String end) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("id", id);
        e.put("status", "confirmed");
        e.put("summary", title);
        e.put("start", Map.of("dateTime", start));
        e.put("end", Map.of("dateTime", end));
        e.put("htmlLink", "https://calendar.example/" + id);
        events.put(id, e);
    }

    public Map<String, Map<String, String>> drafts() {
        return drafts;
    }

    // ---- request handling -----------------------------------------------------------------------

    private void handle(HttpExchange x) throws IOException {
        String method = x.getRequestMethod();
        String path = x.getRequestURI().getPath();
        String query = x.getRequestURI().getRawQuery();
        requests.add(new Request(method, path, query));
        byte[] in = x.getRequestBody().readAllBytes();
        String key = method + " " + path;
        try {
            for (Map.Entry<String, Failure> f : failures.entrySet()) {
                if (key.startsWith(f.getKey()) && f.getValue().remaining().getAndDecrement() > 0) {
                    send(x, f.getValue().status(), f.getValue().status() == 403
                            ? Map.of("error", Map.of("code", 403, "errors", List.of(Map.of("reason", "rateLimitExceeded"))))
                            : Map.of("error", Map.of("code", f.getValue().status())));
                    return;
                }
            }
            if (path.equals("/token")) {
                token(x, form(new String(in, StandardCharsets.UTF_8)));
                return;
            }
            if (path.equals("/revoke")) {
                validRefresh.remove(form(new String(in, StandardCharsets.UTF_8)).get("token"));
                revocations.incrementAndGet();
                send(x, 200, Map.of());
                return;
            }
            String auth = x.getRequestHeaders().getFirst("Authorization");
            if (auth == null || !validAccess.contains(auth.replace("Bearer ", ""))) {
                send(x, 401, Map.of("error", Map.of("code", 401)));
                return;
            }
            boolean failAfter = applyThenFail.stream().filter(key::startsWith).findFirst().map(applyThenFail::remove).orElse(false);
            Object[] result = path.startsWith("/gmail/") ? gmail(method, path, query, in) : calendar(method, path, query, in);
            if (failAfter) {
                send(x, 503, Map.of("error", Map.of("code", 503)));
                return;
            }
            send(x, (Integer) result[0], result[1]);
        } catch (RuntimeException e) {
            send(x, 500, Map.of("error", Map.of("message", String.valueOf(e))));
        }
    }

    private void token(HttpExchange x, Map<String, String> f) throws IOException {
        String grant = f.get("grant_type");
        if ("authorization_code".equals(grant)) {
            if (!GOOD_CODE.equals(f.get("code")) || f.get("code_verifier") == null || f.get("code_verifier").length() < 43) {
                send(x, 400, Map.of("error", "invalid_grant"));
                return;
            }
            String refresh = "refresh-" + counter.incrementAndGet();
            validRefresh.add(refresh);
            send(x, 200, Map.of("access_token", newAccess(), "expires_in", 3600, "refresh_token", refresh,
                    "scope", "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly "
                            + "https://www.googleapis.com/auth/gmail.compose", "token_type", "Bearer"));
            return;
        }
        if ("refresh_token".equals(grant)) {
            refreshes.incrementAndGet();
            if (!validRefresh.contains(f.get("refresh_token"))) {
                send(x, 400, Map.of("error", "invalid_grant", "error_description", "Token has been expired or revoked."));
                return;
            }
            send(x, 200, Map.of("access_token", newAccess(), "expires_in", 3600, "token_type", "Bearer"));
            return;
        }
        send(x, 400, Map.of("error", "unsupported_grant_type"));
    }

    private String newAccess() {
        String a = "access-" + counter.incrementAndGet();
        validAccess.add(a);
        return a;
    }

    private Object[] gmail(String method, String path, String query, byte[] in) {
        Map<String, String> q = form(query == null ? "" : query);
        String p = path.substring("/gmail/v1/users/me".length());
        if (method.equals("GET") && p.equals("/profile")) {
            return ok(Map.of("emailAddress", ACCOUNT, "historyId", String.valueOf(historyId)));
        }
        if (method.equals("GET") && p.equals("/messages")) {
            int max = Integer.parseInt(q.getOrDefault("maxResults", "100"));
            List<Map<String, String>> list = new ArrayList<>();
            synchronized (messages) {
                List<String> ids = new ArrayList<>(messages.keySet());
                Collections.reverse(ids);
                for (String id : ids) {
                    @SuppressWarnings("unchecked")
                    List<String> labels = (List<String>) messages.get(id).get("labelIds");
                    if (labels.contains("UNREAD") && labels.stream().noneMatch(l -> l.startsWith("CATEGORY_") && !l.equals("CATEGORY_PERSONAL"))
                            && list.size() < max) {
                        list.add(Map.of("id", id, "threadId", "thr" + id));
                    }
                }
            }
            return ok(Map.of("messages", list, "resultSizeEstimate", list.size()));
        }
        Matcher m = Pattern.compile("^/messages/([^/]+)$").matcher(p);
        if (method.equals("GET") && m.matches()) {
            Map<String, Object> msg = messages.get(m.group(1));
            return msg == null ? notFound() : ok(msg);
        }
        if (method.equals("GET") && p.equals("/history")) {
            long start = Long.parseLong(q.get("startHistoryId"));
            if (start < oldestHistory) {
                return notFound();
            }
            List<Map<String, Object>> history = new ArrayList<>();
            messageHistory.forEach((id, h) -> {
                if (h > start) {
                    history.add(Map.of("id", String.valueOf(h), "messagesAdded", List.of(Map.of("message", Map.of("id", id)))));
                }
            });
            return ok(Map.of("history", history, "historyId", String.valueOf(historyId)));
        }
        if (method.equals("POST") && p.equals("/drafts")) {
            JsonNode body = JSON.readTree(in);
            String raw = body.path("message").path("raw").asString();
            String id = "r" + counter.incrementAndGet();
            Map<String, String> d = new ConcurrentHashMap<>(Map.of("id", id, "messageId", "m" + id, "raw", raw));
            drafts.put(id, d);
            return ok(Map.of("id", id, "message", Map.of("id", d.get("messageId"))));
        }
        if (method.equals("GET") && p.equals("/drafts")) {
            String wanted = q.getOrDefault("q", "").replace("rfc822msgid:", "");
            List<Map<String, Object>> found = new ArrayList<>();
            for (Map<String, String> d : drafts.values()) {
                if (!wanted.isEmpty() && decode(d.get("raw")).contains("Message-ID: <" + wanted + ">")) {
                    found.add(Map.of("id", d.get("id"), "message", Map.of("id", d.get("messageId"))));
                }
            }
            return ok(found.isEmpty() ? Map.of("resultSizeEstimate", 0) : Map.of("drafts", found));
        }
        Matcher dm = Pattern.compile("^/drafts/([^/]+)$").matcher(p);
        if (dm.matches()) {
            Map<String, String> d = drafts.get(dm.group(1));
            if (d == null) {
                return notFound();
            }
            if (method.equals("GET")) {
                return ok(Map.of("id", d.get("id"), "message", Map.of("id", d.get("messageId"))));
            }
            if (method.equals("PUT")) {
                d.put("raw", JSON.readTree(in).path("message").path("raw").asString());
                return ok(Map.of("id", d.get("id"), "message", Map.of("id", d.get("messageId"))));
            }
        }
        // Anything else (send, trash, delete, modify...) isn't part of what SMOI may use.
        return new Object[] {404, Map.of("error", Map.of("code", 404, "message", "not in fake"))};
    }

    private Object[] calendar(String method, String path, String query, byte[] in) {
        String base = "/calendar/v3/calendars/primary/events";
        if (!path.startsWith(base)) {
            return notFound();
        }
        String rest = path.substring(base.length());
        if (rest.isEmpty() && method.equals("GET")) {
            Map<String, String> q = form(query == null ? "" : query);
            String min = q.get("timeMin");
            String max = q.get("timeMax");
            List<Map<String, Object>> items = new ArrayList<>();
            synchronized (events) {
                for (Map<String, Object> e : events.values()) {
                    String s = instant(e, "start");
                    String en = instant(e, "end");
                    if ((max == null || s.compareTo(norm(max)) < 0) && (min == null || en.compareTo(norm(min)) > 0)) {
                        items.add(e);
                    }
                }
            }
            items.sort((a, b) -> instant(a, "start").compareTo(instant(b, "start")));
            return ok(Map.of("items", items));
        }
        if (rest.isEmpty() && method.equals("POST")) {
            JsonNode b = JSON.readTree(in);
            String id = b.path("id").asString();
            if (events.containsKey(id)) {
                return new Object[] {409, Map.of("error", Map.of("code", 409, "message", "The requested identifier already exists."))};
            }
            Map<String, Object> e = JSON.convertValue(b, Map.class);
            e.put("status", "confirmed");
            e.put("htmlLink", "https://calendar.example/" + id);
            events.put(id, e);
            return ok(e);
        }
        String id = rest.substring(1);
        Map<String, Object> e = events.get(id);
        if (e == null) {
            return notFound();
        }
        switch (method) {
            case "GET" -> {
                return ok(e);
            }
            case "PATCH" -> {
                @SuppressWarnings("unchecked")
                Map<String, Object> patch = JSON.convertValue(JSON.readTree(in), Map.class);
                e.putAll(patch);
                return ok(e);
            }
            case "DELETE" -> {
                events.remove(id);
                return new Object[] {204, null};
            }
            default -> {
                return notFound();
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static String instant(Map<String, Object> e, String field) {
        return norm(((Map<String, Object>) e.get(field)).get("dateTime").toString());
    }

    private static String norm(String dateTime) {
        return java.time.OffsetDateTime.parse(dateTime).toInstant().toString();
    }

    private static String decode(String raw) {
        return new String(Base64.getUrlDecoder().decode(raw), StandardCharsets.UTF_8);
    }

    private static Object[] ok(Object body) {
        return new Object[] {200, body};
    }

    private static Object[] notFound() {
        return new Object[] {404, Map.of("error", Map.of("code", 404))};
    }

    private static Map<String, String> form(String s) {
        Map<String, String> m = new LinkedHashMap<>();
        for (String pair : s.split("&")) {
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String k = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), StandardCharsets.UTF_8);
            String v = eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            m.put(k, v);
        }
        return m;
    }

    private static void send(HttpExchange x, int status, Object body) throws IOException {
        if (body == null || status == 204) {
            x.sendResponseHeaders(status, -1);
            x.close();
            return;
        }
        byte[] out = JSON.writeValueAsBytes(body);
        x.getResponseHeaders().add("Content-Type", "application/json");
        x.sendResponseHeaders(status, out.length);
        x.getResponseBody().write(out);
        x.close();
    }
}
