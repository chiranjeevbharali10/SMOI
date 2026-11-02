package com.smoi.support;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;

/** Builds real PDF, DOCX and TXT files in memory, so tests don't depend on binary fixtures. */
public final class TestFiles {

    private TestFiles() {
    }

    /**
     * A PDF with one page per element of {@code pages}; each page holds the given paragraphs.
     * Lines wrap at about 80 characters, and paragraphs are separated by a larger gap, which
     * is how Tika recognises paragraphs in a PDF.
     */
    public static byte[] pdf(List<List<String>> pages) {
        try (PDDocument doc = new PDDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            PDType1Font font = new PDType1Font(Standard14Fonts.FontName.HELVETICA);
            for (List<String> paragraphs : pages) {
                PDPage page = new PDPage();
                doc.addPage(page);
                try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
                    cs.beginText();
                    cs.setFont(font, 11);
                    cs.newLineAtOffset(60, 740);
                    for (String paragraph : paragraphs) {
                        for (String line : wrap(paragraph, 80)) {
                            cs.showText(line);
                            cs.newLineAtOffset(0, -14);
                        }
                        // A gap of ~3 line heights: PDFBox treats more than 2.5 as a new paragraph.
                        cs.newLineAtOffset(0, -30);
                    }
                    cs.endText();
                }
            }
            doc.save(out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** A paragraph or heading for {@link #docx}. {@code headingLevel} 0 means a normal paragraph. */
    public record DocxParagraph(int headingLevel, String text) {

        public static DocxParagraph heading(int level, String text) {
            return new DocxParagraph(level, text);
        }

        public static DocxParagraph text(String text) {
            return new DocxParagraph(0, text);
        }
    }

    /**
     * A minimal DOCX. A DOCX file is a zip of XML parts; this writes the five parts Word needs,
     * with "heading N" styles so Tika reports headings as {@code <hN>}.
     */
    public static byte[] docx(List<DocxParagraph> paragraphs) {
        String w = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"";
        StringBuilder body = new StringBuilder();
        for (DocxParagraph p : paragraphs) {
            body.append("<w:p>");
            if (p.headingLevel() > 0) {
                body.append("<w:pPr><w:pStyle w:val=\"Heading").append(p.headingLevel()).append("\"/></w:pPr>");
            }
            body.append("<w:r><w:t xml:space=\"preserve\">").append(escapeXml(p.text())).append("</w:t></w:r></w:p>");
        }
        StringBuilder styles = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:styles " + w + ">");
        for (int level = 1; level <= 6; level++) {
            styles.append("<w:style w:type=\"paragraph\" w:styleId=\"Heading").append(level)
                    .append("\"><w:name w:val=\"heading ").append(level).append("\"/></w:style>");
        }
        styles.append("</w:styles>");

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(out)) {
            put(zip, "[Content_Types].xml", """
                    <?xml version="1.0" encoding="UTF-8"?>
                    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
                    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
                    <Default Extension="xml" ContentType="application/xml"/>
                    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
                    <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
                    </Types>""");
            put(zip, "_rels/.rels", """
                    <?xml version="1.0" encoding="UTF-8"?>
                    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
                    </Relationships>""");
            put(zip, "word/_rels/document.xml.rels", """
                    <?xml version="1.0" encoding="UTF-8"?>
                    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
                    </Relationships>""");
            put(zip, "word/document.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document " + w + "><w:body>"
                    + body + "</w:body></w:document>");
            put(zip, "word/styles.xml", styles.toString());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return out.toByteArray();
    }

    public static byte[] txt(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    /** A sentence-like filler paragraph of roughly {@code words} words that mentions {@code tag}. */
    public static String paragraph(String tag, int words) {
        StringBuilder sb = new StringBuilder(tag).append(" opens this paragraph.");
        String[] filler = {"river", "lantern", "orchard", "copper", "meadow", "harbor", "violet", "granite"};
        for (int i = 0; i < words; i++) {
            sb.append(' ').append(filler[i % filler.length]);
            if (i % 12 == 11) {
                sb.append('.');
            }
        }
        return sb.append(". ").append(tag).append(" closes it.").toString();
    }

    private static List<String> wrap(String text, int width) {
        List<String> lines = new ArrayList<>();
        StringBuilder line = new StringBuilder();
        for (String word : text.split(" ")) {
            if (!line.isEmpty() && line.length() + 1 + word.length() > width) {
                lines.add(line.toString());
                line.setLength(0);
            }
            if (!line.isEmpty()) {
                line.append(' ');
            }
            line.append(word);
        }
        if (!line.isEmpty()) {
            lines.add(line.toString());
        }
        return lines;
    }

    private static void put(ZipOutputStream zip, String name, String content) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(content.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }

    private static String escapeXml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}
