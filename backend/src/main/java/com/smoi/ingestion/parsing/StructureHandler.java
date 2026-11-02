package com.smoi.ingestion.parsing;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import org.xml.sax.Attributes;
import org.xml.sax.helpers.DefaultHandler;

/**
 * Turns the XHTML that Tika emits into a flat list of {@link Block}s.
 *
 * <p>Tika describes every format with the same small set of HTML tags. What matters here:
 * <ul>
 *   <li>PDFs: each page is a {@code <div class="page">}, with {@code <p>} paragraphs inside.</li>
 *   <li>DOCX: headings are {@code <h1>} to {@code <h6>}, paragraphs are {@code <p>}, plus lists and tables.</li>
 * </ul>
 * The handler tracks the current page number and starts a new block at every block-level tag.
 */
class StructureHandler extends DefaultHandler {

    /** Tags that end one block of text and start the next. */
    private static final Set<String> BLOCK_TAGS = Set.of("p", "li", "pre", "blockquote", "tr", "dt", "dd", "caption");
    /** Tags whose text is not document content. */
    private static final Set<String> IGNORED_TAGS = Set.of("head", "script", "style");

    private final List<Block> blocks = new ArrayList<>();
    private final StringBuilder text = new StringBuilder();
    private int page;
    private int headingLevel;
    private int ignoredDepth;

    List<Block> blocks() {
        flush();
        return blocks;
    }

    @Override
    public void startElement(String uri, String localName, String qName, Attributes atts) {
        String tag = tagName(localName, qName);
        if (IGNORED_TAGS.contains(tag)) {
            ignoredDepth++;
        } else if (tag.equals("div") && "page".equals(atts.getValue("class"))) {
            flush();
            page++;
        } else if (headingLevel(tag) > 0) {
            flush();
            headingLevel = headingLevel(tag);
        } else if (BLOCK_TAGS.contains(tag)) {
            flush();
        } else if (tag.equals("td") || tag.equals("th")) {
            text.append(' ');
        } else if (tag.equals("br")) {
            text.append('\n');
        }
    }

    @Override
    public void endElement(String uri, String localName, String qName) {
        String tag = tagName(localName, qName);
        if (IGNORED_TAGS.contains(tag)) {
            ignoredDepth--;
        } else if (headingLevel(tag) > 0 || BLOCK_TAGS.contains(tag) || tag.equals("div")) {
            flush();
        }
    }

    @Override
    public void characters(char[] ch, int start, int length) {
        if (ignoredDepth == 0) {
            text.append(ch, start, length);
        }
    }

    @Override
    public void ignorableWhitespace(char[] ch, int start, int length) {
        characters(ch, start, length);
    }

    /** Emits the text collected so far as one block, unless it is empty after cleaning. */
    private void flush() {
        String cleaned = TextCleaner.cleanParagraph(text.toString());
        text.setLength(0);
        Integer pageNumber = page > 0 ? page : null;
        if (!cleaned.isEmpty()) {
            blocks.add(headingLevel > 0
                    ? Block.heading(headingLevel, cleaned, pageNumber)
                    : Block.paragraph(cleaned, pageNumber));
        }
        headingLevel = 0;
    }

    private static String tagName(String localName, String qName) {
        return (localName == null || localName.isEmpty() ? qName : localName).toLowerCase(Locale.ROOT);
    }

    private static int headingLevel(String tag) {
        if (tag.length() == 2 && tag.charAt(0) == 'h' && tag.charAt(1) >= '1' && tag.charAt(1) <= '6') {
            return tag.charAt(1) - '0';
        }
        return 0;
    }
}
