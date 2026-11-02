package com.smoi.ingestion.chunking;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

import com.smoi.ingestion.parsing.Block;
import org.springframework.stereotype.Component;

/**
 * Splits a parsed document into chunks: passages small enough to embed and to put in a
 * prompt, but big enough to carry a complete thought.
 *
 * <p>Rules, in priority order:
 * <ol>
 *   <li><b>Headings start a new chunk.</b> A chunk never mixes two sections, and it records
 *       the heading path it sits under. The heading text itself is the chunk's first line,
 *       because it often names what the passage is about.</li>
 *   <li><b>Paragraphs stay whole when they fit.</b> If the next paragraph doesn't fit in the
 *       current chunk, the chunk ends before the paragraph instead of in the middle of it.</li>
 *   <li><b>Too-long paragraphs split at sentences</b>, and a sentence longer than a whole chunk
 *       splits at words. This is the only time a cut lands inside a paragraph.</li>
 *   <li><b>Overlap.</b> A new chunk in the same section starts with the last few sentences of
 *       the previous one (up to {@code overlapTokens}). An idea that spans the boundary then
 *       appears whole in at least one chunk. Overlap is whole sentences, never cut mid-sentence,
 *       and it doesn't cross a heading.</li>
 * </ol>
 */
@Component
public class Chunker {

    /** End of a sentence: ".", "!" or "?" followed by whitespace. Simple, and it misses
     *  abbreviations like "e.g.", but it is only used to split oversized paragraphs. */
    private static final Pattern SENTENCE_END = Pattern.compile("(?<=[.!?])\\s+");
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");

    private final int maxTokens;
    private final int overlapTokens;

    public Chunker(ChunkingProperties props) {
        this.maxTokens = props.maxTokens();
        this.overlapTokens = props.overlapTokens();
    }

    public List<ChunkDraft> chunk(List<Block> blocks) {
        Builder builder = new Builder();
        for (Block block : blocks) {
            if (block.isHeading()) {
                builder.startSection(block);
            } else {
                builder.addParagraph(block);
            }
        }
        builder.finish();
        return builder.chunks;
    }

    /**
     * A piece of text inside a chunk: a heading, or one sentence (or a whole paragraph).
     *
     * @param headingLevel   1-6 for a heading, 0 for body text
     * @param startsParagraph whether a blank line goes before it when the chunk is joined
     * @param overlap        copied from the previous chunk, so it doesn't count as new content
     */
    private record Unit(String text, Integer page, int headingLevel, boolean startsParagraph, boolean overlap, int tokens) {

        static Unit body(String text, Integer page, boolean startsParagraph) {
            return new Unit(text, page, 0, startsParagraph, false, TokenEstimator.estimate(text));
        }

        Unit asOverlap() {
            return new Unit(text, page, headingLevel, startsParagraph, true, tokens);
        }

        boolean isHeading() {
            return headingLevel > 0;
        }
    }

    /** Collects units for the chunk being built and emits it when it is full. */
    private final class Builder {

        final List<ChunkDraft> chunks = new ArrayList<>();
        /** headings[i] is the current heading at level i + 1. */
        final List<String> headings = new ArrayList<>();
        List<Unit> current = new ArrayList<>();
        int currentTokens;

        void startSection(Block heading) {
            if (hasNewContent()) {
                emit(false, 0);
            } else {
                // Nothing written under the previous heading yet. Drop leftover overlap, and
                // drop earlier headings at the same or a deeper level ("A" then "B" at the same
                // level means "A" was empty), but keep parents ("Chapter 1" then "1.1 Intro").
                current.removeIf(u -> !u.isHeading() || u.headingLevel() >= heading.headingLevel());
                recount();
            }
            while (headings.size() >= heading.headingLevel()) {
                headings.removeLast();
            }
            while (headings.size() < heading.headingLevel() - 1) {
                headings.add(null); // a skipped level, for example an h3 directly under an h1
            }
            headings.add(heading.text());
            add(new Unit(heading.text(), heading.page(), heading.headingLevel(), true, false,
                    TokenEstimator.estimate(heading.text())));
        }

        void addParagraph(Block paragraph) {
            int paragraphTokens = TokenEstimator.estimate(paragraph.text());
            if (paragraphTokens <= maxTokens) {
                if (currentTokens + paragraphTokens > maxTokens && hasNewContent()) {
                    emit(true, paragraphTokens);
                }
                add(Unit.body(paragraph.text(), paragraph.page(), true));
                return;
            }
            // Too long for one chunk: fill chunks sentence by sentence.
            boolean first = true;
            for (String piece : splitToFit(paragraph.text())) {
                Unit unit = Unit.body(piece, paragraph.page(), first);
                if (currentTokens + unit.tokens() > maxTokens && hasNewContent()) {
                    emit(true, unit.tokens());
                }
                add(unit);
                first = false;
            }
        }

        void finish() {
            if (hasNewContent()) {
                emit(false, 0);
            }
        }

        private void add(Unit unit) {
            current.add(unit);
            currentTokens += unit.tokens();
        }

        /** True if the chunk has text that isn't a heading or overlap from the previous chunk. */
        private boolean hasNewContent() {
            return current.stream().anyMatch(u -> !u.isHeading() && !u.overlap());
        }

        /**
         * Ends the current chunk. With {@code carryOverlap}, the next chunk starts with the last
         * sentences of this one, as many as fit in the overlap budget and leave room for the
         * {@code incomingTokens} that are about to be added.
         */
        private void emit(boolean carryOverlap, int incomingTokens) {
            chunks.add(toDraft());
            List<Unit> next = new ArrayList<>();
            if (carryOverlap) {
                int budget = Math.min(overlapTokens, maxTokens - incomingTokens);
                int used = 0;
                for (int i = current.size() - 1; i >= 0; i--) {
                    Unit unit = current.get(i);
                    if (unit.isHeading() || used + unit.tokens() > budget) {
                        break;
                    }
                    next.addFirst(unit.asOverlap());
                    used += unit.tokens();
                }
            }
            current = next;
            recount();
        }

        private ChunkDraft toDraft() {
            StringBuilder text = new StringBuilder();
            Integer pageStart = null;
            Integer pageEnd = null;
            for (Unit unit : current) {
                if (!text.isEmpty()) {
                    text.append(unit.startsParagraph() ? "\n\n" : " ");
                }
                text.append(unit.text());
                if (unit.page() != null) {
                    pageStart = pageStart == null ? unit.page() : Math.min(pageStart, unit.page());
                    pageEnd = pageEnd == null ? unit.page() : Math.max(pageEnd, unit.page());
                }
            }
            String joined = text.toString();
            return new ChunkDraft(chunks.size(), joined, pageStart, pageEnd, sectionPath(),
                    TokenEstimator.estimate(joined));
        }

        private String sectionPath() {
            List<String> present = headings.stream().filter(h -> h != null).toList();
            return present.isEmpty() ? null : String.join(" > ", present);
        }

        private void recount() {
            currentTokens = current.stream().mapToInt(Unit::tokens).sum();
        }
    }

    /** Splits an oversized paragraph into sentences, and any sentence still too long into word runs. */
    private List<String> splitToFit(String paragraph) {
        List<String> pieces = new ArrayList<>();
        for (String sentence : SENTENCE_END.split(paragraph)) {
            if (TokenEstimator.estimate(sentence) <= maxTokens) {
                pieces.add(sentence);
                continue;
            }
            StringBuilder piece = new StringBuilder();
            for (String word : WHITESPACE.split(sentence)) {
                for (String part : splitLongWord(word)) {
                    if (!piece.isEmpty() && TokenEstimator.estimate(piece + " " + part) > maxTokens) {
                        pieces.add(piece.toString());
                        piece.setLength(0);
                    }
                    if (!piece.isEmpty()) {
                        piece.append(' ');
                    }
                    piece.append(part);
                }
            }
            if (!piece.isEmpty()) {
                pieces.add(piece.toString());
            }
        }
        return pieces;
    }

    /** A "word" longer than a whole chunk (for example a long URL or encoded data) is cut by length. */
    private List<String> splitLongWord(String word) {
        int maxChars = maxTokens * 4;
        if (word.length() <= maxChars) {
            return List.of(word);
        }
        List<String> parts = new ArrayList<>();
        for (int i = 0; i < word.length(); i += maxChars) {
            parts.add(word.substring(i, Math.min(word.length(), i + maxChars)));
        }
        return parts;
    }
}
