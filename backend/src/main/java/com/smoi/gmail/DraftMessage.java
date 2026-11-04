package com.smoi.gmail;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.regex.Pattern;

/**
 * A draft's recipient, subject and body, checked and encoded as the RFC 5322 message Gmail
 * expects ({@code raw}, base64url).
 *
 * <p>Header injection is the risk here: a subject containing a line break could add a {@code Bcc:}
 * header. So the recipient must be one plain address, the subject is MIME-encoded (RFC 2047) and
 * may not contain line breaks, and the body is base64-encoded.
 */
public record DraftMessage(String to, String subject, String body) {

    public static final int MAX_SUBJECT = 998;
    public static final int MAX_BODY = 20_000;
    /** One address, no display name, no list, no line breaks. Deliberately stricter than RFC 5322. */
    private static final Pattern ADDRESS = Pattern.compile("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$");

    public DraftMessage {
        to = to == null ? "" : to.strip();
        subject = subject == null ? "" : subject.strip();
        body = body == null ? "" : body;
        if (to.length() > 320 || !ADDRESS.matcher(to).matches()) {
            throw new IllegalArgumentException("The recipient must be one email address.");
        }
        if (subject.length() > MAX_SUBJECT || subject.contains("\r") || subject.contains("\n")) {
            throw new IllegalArgumentException("The subject must be one line of at most " + MAX_SUBJECT + " characters.");
        }
        if (body.length() > MAX_BODY) {
            throw new IllegalArgumentException("The body is too long.");
        }
    }

    /** The whole message, base64url-encoded, for Gmail's {@code message.raw}. */
    public String raw() {
        return raw(null);
    }

    /**
     * @param messageId a Message-ID to set (without angle brackets), so a retried create can find
     *                  the draft an earlier attempt may already have made; null for none
     */
    public String raw(String messageId) {
        if (messageId != null && !messageId.matches("[A-Za-z0-9.-]+@[A-Za-z0-9.-]+")) {
            throw new IllegalArgumentException("Bad Message-ID");
        }
        String mime = (messageId == null ? "" : "Message-ID: <" + messageId + ">\r\n")
                + "To: " + to + "\r\n"
                + "Subject: " + encodedWord(subject) + "\r\n"
                + "MIME-Version: 1.0\r\n"
                + "Content-Type: text/plain; charset=UTF-8\r\n"
                + "Content-Transfer-Encoding: base64\r\n"
                + "\r\n"
                + Base64.getMimeEncoder().encodeToString(body.getBytes(StandardCharsets.UTF_8)) + "\r\n";
        return Base64.getUrlEncoder().withoutPadding().encodeToString(mime.getBytes(StandardCharsets.UTF_8));
    }

    private static String encodedWord(String s) {
        return s.isEmpty() ? "" : "=?UTF-8?B?" + Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8)) + "?=";
    }
}
