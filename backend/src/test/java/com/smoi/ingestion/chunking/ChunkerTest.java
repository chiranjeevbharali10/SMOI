package com.smoi.ingestion.chunking;

import java.util.List;

import com.smoi.ingestion.parsing.Block;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Fast unit tests for the chunking rules. Sizes use 4 characters per token. */
class ChunkerTest {

    /** max 100 tokens (~400 chars), overlap up to 20 tokens (~80 chars). */
    private final Chunker chunker = new Chunker(new ChunkingProperties(100, 20));

    /** A sentence of exactly {@code tokens} tokens (4 characters each, ending in ". "). */
    private static String sentence(String tag, int tokens) {
        String body = tag + " " + "x".repeat(Math.max(0, tokens * 4 - tag.length() - 2));
        return body + ".";
    }

    @Test
    void smallParagraphsArePackedIntoOneChunk() {
        List<ChunkDraft> chunks = chunker.chunk(List.of(
                Block.paragraph(sentence("a", 20), null),
                Block.paragraph(sentence("b", 20), null),
                Block.paragraph(sentence("c", 20), null)));

        assertThat(chunks).singleElement().satisfies(c -> {
            assertThat(c.index()).isZero();
            assertThat(c.text()).startsWith("a ").contains("\n\nb ").contains("\n\nc ");
        });
    }

    @Test
    void aChunkEndsBeforeAParagraphThatDoesNotFitRatherThanInsideIt() {
        String first = sentence("first", 70);
        String second = sentence("second", 70);

        List<ChunkDraft> chunks = chunker.chunk(List.of(Block.paragraph(first, null), Block.paragraph(second, null)));

        assertThat(chunks).extracting(ChunkDraft::text).containsExactly(first, second);
    }

    @Test
    void headingsStartANewChunkAndBuildTheSectionPath() {
        List<ChunkDraft> chunks = chunker.chunk(List.of(
                Block.heading(1, "Guide", null),
                Block.paragraph(sentence("intro", 10), null),
                Block.heading(2, "Frogs", null),
                Block.paragraph(sentence("frogs", 10), null),
                Block.heading(2, "Toads", null),
                Block.paragraph(sentence("toads", 10), null),
                Block.heading(1, "Appendix", null),
                Block.paragraph(sentence("appendix", 10), null)));

        assertThat(chunks).extracting(ChunkDraft::section)
                .containsExactly("Guide", "Guide > Frogs", "Guide > Toads", "Appendix");
        assertThat(chunks.get(1).text()).startsWith("Frogs\n\nfrogs");
    }

    @Test
    void headingsWithNothingBetweenThemAreMergedIntoTheNextChunk() {
        List<ChunkDraft> chunks = chunker.chunk(List.of(
                Block.heading(1, "Chapter 1", null),
                Block.heading(2, "Intro", null),
                Block.paragraph(sentence("body", 10), null)));

        assertThat(chunks).singleElement().satisfies(c -> {
            assertThat(c.section()).isEqualTo("Chapter 1 > Intro");
            assertThat(c.text()).startsWith("Chapter 1\n\nIntro\n\nbody");
        });
    }

    @Test
    void anEmptySectionAtTheSameLevelIsDropped() {
        List<ChunkDraft> chunks = chunker.chunk(List.of(
                Block.heading(1, "Empty", null),
                Block.heading(1, "Real", null),
                Block.paragraph(sentence("body", 10), null)));

        assertThat(chunks).singleElement().satisfies(c -> {
            assertThat(c.section()).isEqualTo("Real");
            assertThat(c.text()).doesNotContain("Empty");
        });
    }

    @Test
    void aLongParagraphIsSplitAtSentencesWithOverlap() {
        // 10 sentences of 15 tokens = 150 tokens, more than one chunk.
        StringBuilder paragraph = new StringBuilder();
        for (int i = 0; i < 10; i++) {
            paragraph.append(sentence("s" + i, 15)).append(' ');
        }

        List<ChunkDraft> chunks = chunker.chunk(List.of(Block.paragraph(paragraph.toString().strip(), null)));

        assertThat(chunks).hasSize(2);
        assertThat(chunks).allSatisfy(c -> assertThat(c.tokenCount()).isLessThanOrEqualTo(100));
        // The second chunk starts with the last sentence of the first (15 tokens fit in the 20-token overlap).
        String lastSentenceOfFirst = chunks.get(0).text().substring(chunks.get(0).text().lastIndexOf("s"));
        assertThat(chunks.get(1).text()).startsWith(lastSentenceOfFirst);
        // Nothing is lost: every sentence appears in some chunk.
        for (int i = 0; i < 10; i++) {
            String tag = "s" + i + " ";
            assertThat(chunks).anySatisfy(c -> assertThat(c.text()).contains(tag));
        }
    }

    @Test
    void overlapDoesNotCrossAHeading() {
        List<ChunkDraft> chunks = chunker.chunk(List.of(
                Block.heading(1, "One", null),
                Block.paragraph(sentence("alpha", 5), null),
                Block.heading(1, "Two", null),
                Block.paragraph(sentence("beta", 5), null)));

        assertThat(chunks.get(1).text()).doesNotContain("alpha");
    }

    @Test
    void aSentenceLongerThanAChunkIsSplitAtWords() {
        String words = "word ".repeat(200).strip(); // 1000 characters, no sentence end

        List<ChunkDraft> chunks = chunker.chunk(List.of(Block.paragraph(words, null)));

        assertThat(chunks).hasSizeGreaterThan(2).allSatisfy(c -> assertThat(c.tokenCount()).isLessThanOrEqualTo(100));
        assertThat(chunks).allSatisfy(c -> assertThat(c.text()).doesNotContain("wo rd"));
    }

    @Test
    void aSingleHugeWordIsCutByLength() {
        List<ChunkDraft> chunks = chunker.chunk(List.of(Block.paragraph("y".repeat(1000), null)));

        assertThat(chunks).hasSize(3).allSatisfy(c -> assertThat(c.tokenCount()).isLessThanOrEqualTo(100));
    }

    @Test
    void pageRangeCoversEveryPageTheChunkUses() {
        List<ChunkDraft> chunks = chunker.chunk(List.of(
                Block.paragraph(sentence("p1", 10), 1),
                Block.paragraph(sentence("p2", 10), 2),
                Block.paragraph(sentence("p3", 90), 3)));

        assertThat(chunks).hasSize(2);
        assertThat(chunks.get(0).pageStart()).isEqualTo(1);
        assertThat(chunks.get(0).pageEnd()).isEqualTo(2);
        // The second chunk begins with overlap from page 2, so its range starts there.
        assertThat(chunks.get(1).pageStart()).isEqualTo(2);
        assertThat(chunks.get(1).pageEnd()).isEqualTo(3);
    }

    @Test
    void formatsWithoutPagesHaveNoPageRange() {
        assertThat(chunker.chunk(List.of(Block.paragraph("text.", null))))
                .singleElement().satisfies(c -> {
                    assertThat(c.pageStart()).isNull();
                    assertThat(c.pageEnd()).isNull();
                    assertThat(c.section()).isNull();
                });
    }

    @Test
    void noBlocksMeansNoChunks() {
        assertThat(chunker.chunk(List.of())).isEmpty();
    }
}
