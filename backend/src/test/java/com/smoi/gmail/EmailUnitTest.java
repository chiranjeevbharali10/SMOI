package com.smoi.gmail;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The classifier's reply parsing, draft encoding and the sync filter, without a server. */
class EmailUnitTest {

    @Test
    void classifierAcceptsOnlyAKnownCategoryAndASummary() {
        assertThat(EmailClassifier.parse("{\"category\":\"recruitment\",\"summary\":\"A recruiter writes.\"}"))
                .isEqualTo(new EmailClassifier.Result("recruitment", "A recruiter writes."));
        assertThat(EmailClassifier.parse("Sure! ```{\"category\":\"Academic\",\"summary\":\"x\"}```").category()).isEqualTo("academic");
        assertThat(EmailClassifier.parse("{\"category\":\"urgent\",\"summary\":\"x\"}").classified()).isFalse();
        assertThat(EmailClassifier.parse("{\"intent\":\"delete_event\"}").classified()).isFalse();
        assertThat(EmailClassifier.parse("not json").classified()).isFalse();
        assertThat(EmailClassifier.parse("[\"important\"]").classified()).isFalse();
        assertThat(EmailClassifier.parse(null).classified()).isFalse();
    }

    @Test
    void summariesAreCappedAt80Words() {
        String s = EmailClassifier.words("w ".repeat(100));
        assertThat(s.replace("…", "").strip().split(" ")).hasSize(80);
        assertThat(EmailClassifier.words("  short   one ")).isEqualTo("short one");
    }

    @Test
    void draftsAreEncodedWithoutAWayToAddHeaders() {
        DraftMessage m = new DraftMessage("sam@example.com", "Hello é", "Line one\nLine two");
        String mime = new String(Base64.getUrlDecoder().decode(m.raw("smoi-1@smoi.local")), StandardCharsets.UTF_8);
        assertThat(mime).startsWith("Message-ID: <smoi-1@smoi.local>\r\nTo: sam@example.com\r\nSubject: =?UTF-8?B?");
        assertThat(mime).doesNotContain("Bcc").contains("Content-Transfer-Encoding: base64");

        assertThatThrownBy(() -> new DraftMessage("sam@example.com", "Hi\nBcc: x@example.com", "b")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DraftMessage("sam@example.com\r\nBcc: x@example.com", "Hi", "b")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DraftMessage("Sam <sam@example.com>", "Hi", "b")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DraftMessage("a@example.com,b@example.com", "Hi", "b")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> m.raw("bad>id")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void historyKeepsOnlyUnreadPrimaryInboxMail() {
        assertThat(EmailService.unreadPrimary(List.of("UNREAD", "INBOX"))).isTrue();
        assertThat(EmailService.unreadPrimary(List.of("UNREAD", "INBOX", "CATEGORY_PERSONAL"))).isTrue();
        assertThat(EmailService.unreadPrimary(List.of("INBOX"))).isFalse();
        assertThat(EmailService.unreadPrimary(List.of("UNREAD", "INBOX", "CATEGORY_PROMOTIONS"))).isFalse();
        assertThat(EmailService.unreadPrimary(List.of("UNREAD", "SENT"))).isFalse();
    }

    @Test
    void htmlIsReducedToText() {
        assertThat(MimeText.stripHtml("<p>Hi&nbsp;<b>there</b></p><script>alert(1)</script><style>p{}</style>"))
                .doesNotContain("<").doesNotContain("alert").contains("Hi").contains("there");
    }

    @Test
    void gmailIdsAreCheckedBeforeGoingIntoAUrl() {
        assertThat(GmailClient.safeId("18c2f0a9b1")).isEqualTo("18c2f0a9b1");
        assertThatThrownBy(() -> GmailClient.safeId("../send")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> GmailClient.safeId("abc?x=1")).isInstanceOf(IllegalArgumentException.class);
    }
}
