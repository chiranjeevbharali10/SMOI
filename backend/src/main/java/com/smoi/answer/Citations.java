package com.smoi.answer;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Finds the citations in a model's answer and checks them against the sources it was given
 * (FR-06.12). The model is told to cite with {@code [S1]}-style labels; anything that looks like
 * a citation but doesn't name a source from this prompt is a fabricated citation.
 */
final class Citations {

    /** Bracketed text, up to 80 characters: "[S1]", "[S1, S3]", but also "[sic]" or "[1]". */
    private static final Pattern BRACKET = Pattern.compile("\\[([^\\[\\]]{1,80})]");
    private static final Pattern LABEL = Pattern.compile("S\\d+");
    private static final Pattern UUID_LIKE = Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    /** Citation-shaped tokens that aren't our format, for example "[source 2]" or "[doc 1]". */
    private static final Pattern OTHER_CITATION = Pattern.compile("(?i)(source|doc|document|chunk|ref)\\s*#?\\d+");

    /**
     * @param cited   valid labels in order of first use, without duplicates
     * @param invalid citation-shaped tokens that don't name a source in this prompt
     */
    record Check(List<String> cited, List<String> invalid) {

        boolean valid() {
            return invalid.isEmpty();
        }
    }

    static Check check(String answer, Set<String> allowedLabels) {
        Set<String> cited = new LinkedHashSet<>();
        Set<String> invalid = new LinkedHashSet<>();
        Matcher m = BRACKET.matcher(answer);
        while (m.find()) {
            for (String token : m.group(1).split("[,;]")) {
                String t = token.strip();
                if (LABEL.matcher(t).matches()) {
                    (allowedLabels.contains(t) ? cited : invalid).add(t);
                } else if (UUID_LIKE.matcher(t).matches() || OTHER_CITATION.matcher(t).matches()) {
                    invalid.add(t);
                }
            }
        }
        return new Check(new ArrayList<>(cited), new ArrayList<>(invalid));
    }

    /**
     * True if the reply contains the fixed "don't know" sentence anywhere. Small models often add a
     * preamble ("There is no information about X [S1][S2]. I don't know based on your documents.")
     * instead of replying with the sentence alone. Such a reply must not count as an answer, and
     * the citations in its preamble don't support anything.
     */
    static boolean isDontKnow(String answer) {
        String normalized = answer.replace('’', '\'').toLowerCase(Locale.ROOT);
        return normalized.contains(Prompts.DONT_KNOW.toLowerCase(Locale.ROOT).replace(".", ""));
    }

    private Citations() {
    }
}
