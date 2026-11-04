package com.smoi.gmail;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import tools.jackson.databind.JsonNode;

/**
 * Turns a Gmail API message ({@code format=full}) into plain text: the From and Subject headers
 * and a text body. Prefers a {@code text/plain} part; otherwise strips the tags from
 * {@code text/html}. The result is untrusted data, capped in length, and only ever shown as text.
 */
final class MimeText {

    static final int MAX_BODY = 20_000;
    static final int MAX_SUBJECT = 1000;
    static final int MAX_FROM = 500;

    private MimeText() {
    }

    static GmailClient.Message toMessage(JsonNode m) {
        JsonNode payload = m.path("payload");
        String from = "";
        String subject = "";
        for (JsonNode h : payload.path("headers")) {
            String name = h.path("name").asString("");
            if (name.equalsIgnoreCase("From")) {
                from = h.path("value").asString("");
            } else if (name.equalsIgnoreCase("Subject")) {
                subject = h.path("value").asString("");
            }
        }
        List<String> labels = new ArrayList<>();
        for (JsonNode l : m.path("labelIds")) {
            labels.add(l.asString());
        }
        String plain = find(payload, "text/plain");
        String body = plain != null ? plain : stripHtml(find(payload, "text/html"));
        long internal = Long.parseLong(m.path("internalDate").asString("0"));
        return new GmailClient.Message(m.path("id").asString(""), m.path("threadId").asString(""),
                m.path("historyId").asString(""), Instant.ofEpochMilli(internal), List.copyOf(labels),
                cap(oneLine(from), MAX_FROM), cap(oneLine(subject), MAX_SUBJECT), cap(clean(body), MAX_BODY));
    }

    /** Depth-first search for the first part of this MIME type with a body. */
    private static String find(JsonNode part, String mimeType) {
        if (mimeType.equalsIgnoreCase(part.path("mimeType").asString(""))) {
            String data = part.path("body").path("data").asString("");
            if (!data.isEmpty()) {
                return decode(data);
            }
        }
        for (JsonNode p : part.path("parts")) {
            String found = find(p, mimeType);
            if (found != null) {
                return found;
            }
        }
        return null;
    }

    private static String decode(String data) {
        try {
            return new String(Base64.getUrlDecoder().decode(data), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return "";
        }
    }

    static String stripHtml(String html) {
        if (html == null) {
            return "";
        }
        return html.replaceAll("(?is)<(script|style)[^>]*>.*?</\\1>", " ")
                .replaceAll("(?i)<br\\s*/?>|</p>|</div>|</li>", "\n")
                .replaceAll("<[^>]+>", " ")
                .replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", "\"").replace("&#39;", "'");
    }

    private static String clean(String s) {
        return s == null ? "" : s.replace("\r", "").replaceAll("[ \\t]+", " ").replaceAll("\\n{3,}", "\n\n").strip();
    }

    private static String oneLine(String s) {
        return s.replaceAll("[\\r\\n\\t]+", " ").strip();
    }

    private static String cap(String s, int max) {
        return s.length() > max ? s.substring(0, max) : s;
    }
}
