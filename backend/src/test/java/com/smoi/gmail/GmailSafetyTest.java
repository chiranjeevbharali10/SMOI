package com.smoi.gmail;

import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.stream.Stream;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * FR-05.13: SMOI never sends, deletes or trashes email. The gmail.compose scope would let Google
 * accept a send, so this is enforced in code, and this test fails the build if it slips:
 *
 * <ol>
 *   <li>{@link GmailClient} has no method that sends, deletes, trashes or relabels mail;</li>
 *   <li>its source contains none of the Gmail API paths that would;</li>
 *   <li>no other class in the backend talks to the Gmail API: the API host and path appear only
 *       in {@code GmailClient}, so every Gmail call goes through it.</li>
 * </ol>
 */
class GmailSafetyTest {

    private static final Path MAIN = Path.of("src/main/java");
    private static final Path CLIENT = MAIN.resolve("com/smoi/gmail/GmailClient.java");
    private static final List<String> FORBIDDEN_WORDS = List.of("send", "delete", "trash", "modify", "remove", "batch", "import", "insert");

    @Test
    void theClientHasNoSendDeleteTrashOrModifyMethod() {
        List<String> methods = Arrays.stream(GmailClient.class.getDeclaredMethods())
                .filter(m -> !Modifier.isPrivate(m.getModifiers()))
                .map(Method::getName)
                .toList();
        assertThat(methods).isNotEmpty();
        for (String name : methods) {
            String lower = name.toLowerCase(Locale.ROOT);
            assertThat(FORBIDDEN_WORDS).as("GmailClient.%s", name).noneMatch(lower::contains);
        }
    }

    @Test
    void theClientSourceHasNoPathThatSendsDeletesOrChangesMail() throws IOException {
        String src = Files.readString(CLIENT);
        for (String forbidden : List.of("/send", "/trash", "/untrash", "/modify", "batchDelete", "batchModify",
                "\"DELETE\"", "/import", "/messages\", ", "users/me/messages\"")) {
            assertThat(src).as("GmailClient must not contain %s", forbidden).doesNotContain(forbidden);
        }
        // Only these HTTP methods are used: reads, creating a draft, replacing a draft.
        List<String> calls = Arrays.asList(src.split("http\\.call\\(userId, \"", -1)).subList(1, src.split("http\\.call\\(userId, \"", -1).length);
        assertThat(calls).isNotEmpty().allSatisfy(call -> assertThat(call).matches("(?s)^(GET|POST|PUT)\".*"));
        assertThat(src).contains("API + \"/drafts\"").doesNotContain("\"POST\", uri(API + \"/messages");
    }

    @Test
    void noOtherClassTalksToGmail() throws IOException {
        try (Stream<Path> files = Files.walk(MAIN)) {
            List<Path> offenders = files
                    .filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> !p.equals(CLIENT))
                    .filter(p -> {
                        try {
                            String s = Files.readString(p);
                            return s.contains("gmail.googleapis.com") || s.contains("/gmail/v1") || s.contains("gmailUrl()");
                        } catch (IOException e) {
                            throw new java.io.UncheckedIOException(e);
                        }
                    })
                    .toList();
            assertThat(offenders).isEmpty();
        }
    }
}
