package com.smoi.ingestion.parsing;

import java.nio.charset.Charset;
import java.util.List;

import com.smoi.support.TestFiles;
import com.smoi.support.TestFiles.DocxParagraph;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Runs the real Tika parsers in-process; no database needed. */
class DocumentParserTest {

    private final DocumentParser parser = new DocumentParser();

    @Test
    void pdfParagraphsCarryTheirPageNumber() {
        byte[] pdf = TestFiles.pdf(List.of(
                List.of("First page, first paragraph.", "First page, second paragraph."),
                List.of("Second page text.")));

        List<Block> blocks = parser.parse(pdf, DocumentParser.PDF);

        assertThat(blocks).containsExactly(
                Block.paragraph("First page, first paragraph.", 1),
                Block.paragraph("First page, second paragraph.", 1),
                Block.paragraph("Second page text.", 2));
    }

    @Test
    void pdfLinesWrappedByLayoutAreJoinedIntoOneParagraph() {
        String longParagraph = "word ".repeat(40).strip() + "."; // wraps over several lines
        List<Block> blocks = parser.parse(TestFiles.pdf(List.of(List.of(longParagraph))), DocumentParser.PDF);

        assertThat(blocks).singleElement().extracting(Block::text).isEqualTo(longParagraph);
    }

    @Test
    void docxHeadingsAndParagraphsKeepTheirStructure() {
        byte[] docx = TestFiles.docx(List.of(
                DocxParagraph.heading(1, "Title"),
                DocxParagraph.text("Body one."),
                DocxParagraph.heading(2, "Part"),
                DocxParagraph.text("Body two.")));

        assertThat(parser.parse(docx, DocumentParser.DOCX)).containsExactly(
                Block.heading(1, "Title", null),
                Block.paragraph("Body one.", null),
                Block.heading(2, "Part", null),
                Block.paragraph("Body two.", null));
    }

    @Test
    void plainTextParagraphsAreSeparatedByBlankLines() {
        byte[] txt = TestFiles.txt("Title line\n\nPara one line one\nline two.\n   \nPara two.");

        assertThat(parser.parse(txt, DocumentParser.TXT)).extracting(Block::text)
                .containsExactly("Title line", "Para one line one line two.", "Para two.");
    }

    @Test
    void plainTextInWindows1252IsDecodedCorrectly() {
        // Typical English text with a few accented words, as saved by older Windows editors.
        // (Text made mostly of accented characters is classified as binary by Tika's detector.)
        String first = "The café on the corner serves crème brûlée every Friday. "
                + "Most visitors order coffee and stay for an hour or two.";
        byte[] txt = (first + "\n\nSecond paragraph.").getBytes(Charset.forName("windows-1252"));

        assertThat(parser.parse(txt, DocumentParser.TXT)).first().extracting(Block::text).isEqualTo(first);
    }

    @Test
    void corruptPdfIsAParseError() {
        assertThatThrownBy(() -> parser.parse("%PDF-1.7\ngarbage".getBytes(), DocumentParser.PDF))
                .isInstanceOf(DocumentParseException.class)
                .hasMessageStartingWith("Could not read the file");
    }

    @Test
    void pdfWithoutTextIsAParseError() {
        assertThatThrownBy(() -> parser.parse(TestFiles.pdf(List.of(List.of())), DocumentParser.PDF))
                .isInstanceOf(DocumentParseException.class)
                .hasMessageContaining("no extractable text");
    }

    @Test
    void pdfWithoutTextNeedsOcr() {
        assertThatThrownBy(() -> parser.parse(TestFiles.pdf(List.of(List.of(), List.of())), DocumentParser.PDF))
                .isInstanceOf(NeedsOcrException.class)
                .hasMessageContaining(NeedsOcrException.MARKER);
    }

    @Test
    void pdfWithOnlyAStrayPageNumberPerPageNeedsOcr() {
        assertThatThrownBy(() -> parser.parse(TestFiles.pdf(List.of(List.of("1"), List.of("2"), List.of("3"))),
                DocumentParser.PDF))
                .isInstanceOf(NeedsOcrException.class)
                .hasMessageContaining("very little extractable text");
    }

    @Test
    void aShortRealPdfIsNotMistakenForAScan() {
        assertThat(parser.parse(TestFiles.pdf(List.of(List.of("A short note about the garden gate."))), DocumentParser.PDF))
                .extracting(Block::text).containsExactly("A short note about the garden gate.");
    }

    @Test
    void ocrPagesBecomeParagraphsWithPageNumbers() {
        List<Block> blocks = parser.blocksFromPages(List.of(
                "First paragraph on page one,\nwrapped onto two lines.\n\nSecond paragraph.",
                "",
                "Page three text that is long enough."));

        assertThat(blocks).extracting(Block::text, Block::page).containsExactly(
                org.assertj.core.groups.Tuple.tuple("First paragraph on page one, wrapped onto two lines.", 1),
                org.assertj.core.groups.Tuple.tuple("Second paragraph.", 1),
                org.assertj.core.groups.Tuple.tuple("Page three text that is long enough.", 3));
    }

    @Test
    void ocrThatFindsAlmostNothingStillNeedsOcr() {
        assertThatThrownBy(() -> parser.blocksFromPages(List.of("", "x")))
                .isInstanceOf(NeedsOcrException.class)
                .hasMessageContaining(NeedsOcrException.MARKER);
    }

    @Test
    void tooLittleTextIsMeasuredPerPage() {
        List<Block> forty = List.of(Block.paragraph("x".repeat(40), 1));
        assertThat(DocumentParser.tooLittleText(forty, 1)).isFalse();
        assertThat(DocumentParser.tooLittleText(forty, 2)).isFalse();
        assertThat(DocumentParser.tooLittleText(forty, 3)).isTrue();
        assertThat(DocumentParser.tooLittleText(List.of(), 0)).isTrue();
    }
}
