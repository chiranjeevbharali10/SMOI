package com.smoi.ingestion.parsing;

import java.text.Normalizer;
import java.util.regex.Pattern;

/**
 * Cleans one paragraph of extracted text. Text from PDFs keeps the line breaks of the page
 * layout and words split by hyphens at line ends. Left in, these break keyword matching
 * ("informa- tion" doesn't match "information") and add noise to embeddings.
 */
public final class TextCleaner {

    /** "infor-\nmation" -> "information": a hyphen at a line end, followed by a lowercase letter. */
    private static final Pattern HYPHENATED_LINE_BREAK = Pattern.compile("(\\p{L})-\\s*\\R\\s*(\\p{Ll})");
    /** Control characters other than tab and newlines, which some PDFs contain. */
    private static final Pattern CONTROL = Pattern.compile("[\\p{Cc}&&[^\\t\\n\\r]]|\\u00AD");
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");

    private TextCleaner() {
    }

    /** Returns the paragraph as one line of normalised text, or an empty string if nothing is left. */
    public static String cleanParagraph(String raw) {
        // NFKC turns compatibility characters into their plain forms, for example the "ﬁ"
        // ligature into "fi" and a non-breaking space into a space.
        String text = Normalizer.normalize(raw, Normalizer.Form.NFKC);
        text = CONTROL.matcher(text).replaceAll("");
        text = HYPHENATED_LINE_BREAK.matcher(text).replaceAll("$1$2");
        // Within a paragraph, line breaks come from page layout, not meaning.
        return WHITESPACE.matcher(text).replaceAll(" ").strip();
    }
}
