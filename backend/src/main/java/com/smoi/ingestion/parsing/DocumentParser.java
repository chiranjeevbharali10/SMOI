package com.smoi.ingestion.parsing;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

import org.apache.tika.exception.EncryptedDocumentException;
import org.apache.tika.io.TikaInputStream;
import org.apache.tika.metadata.HttpHeaders;
import org.apache.tika.metadata.Metadata;
import org.apache.tika.parser.AutoDetectParser;
import org.apache.tika.parser.ParseContext;
import org.springframework.stereotype.Component;

/**
 * Extracts structured text from an uploaded file with Apache Tika: the parse and clean
 * stages of the ingestion pipeline. The result is a list of headings and paragraphs, each
 * with its page number when the format has pages.
 */
@Component
public class DocumentParser {

    public static final String PDF = "application/pdf";
    public static final String DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    public static final String TXT = "text/plain";

    /** A blank line (possibly containing spaces) separates paragraphs in plain text. */
    private static final Pattern BLANK_LINE = Pattern.compile("\\R[ \\t]*\\R");

    private final AutoDetectParser tika = new AutoDetectParser();

    /**
     * @throws DocumentParseException if the file is corrupt, encrypted or has no text
     */
    public List<Block> parse(byte[] content, String mediaType) {
        StructureHandler handler = new StructureHandler();
        Metadata metadata = new Metadata();
        try (TikaInputStream in = TikaInputStream.get(content)) {
            tika.parse(in, handler, metadata, new ParseContext());
        } catch (EncryptedDocumentException e) {
            throw new DocumentParseException("The file is password-protected", e);
        } catch (Exception e) {
            throw new DocumentParseException("Could not read the file (it may be corrupt): " + rootMessage(e), e);
        }

        List<Block> blocks = TXT.equals(mediaType)
                ? plainTextParagraphs(content, metadata)
                : handler.blocks();
        if (PDF.equals(mediaType) && tooLittleText(blocks, pageCount(metadata))) {
            throw new NeedsOcrException(blocks.isEmpty()
                    ? "The PDF has no extractable text. It looks scanned and needs OCR."
                    : "The PDF has very little extractable text. It looks scanned and needs OCR.");
        }
        if (blocks.isEmpty()) {
            throw new DocumentParseException("The file contains no text");
        }
        return blocks;
    }

    /**
     * Blocks from OCR output: one string per page, paragraphs separated by blank lines.
     *
     * @throws NeedsOcrException if OCR found too little text as well
     */
    public List<Block> blocksFromPages(List<String> pages) {
        List<Block> blocks = new ArrayList<>();
        for (int i = 0; i < pages.size(); i++) {
            String page = pages.get(i) == null ? "" : pages.get(i);
            for (String paragraph : BLANK_LINE.split(page)) {
                String cleaned = TextCleaner.cleanParagraph(paragraph);
                if (!cleaned.isEmpty()) {
                    blocks.add(Block.paragraph(cleaned, i + 1));
                }
            }
        }
        if (tooLittleText(blocks, pages.size())) {
            throw new NeedsOcrException("OCR found too little text in the PDF; it " + NeedsOcrException.MARKER
                    + " with a clearer scan.");
        }
        return blocks;
    }

    /**
     * Below this many characters of text per page on average, a PDF is treated as scanned. A real
     * text page has hundreds; a scan often has only a stray header or page number.
     */
    static final int MIN_CHARS_PER_PAGE = 20;

    static boolean tooLittleText(List<Block> blocks, int pages) {
        long chars = blocks.stream().mapToLong(b -> b.text().length()).sum();
        return chars < (long) MIN_CHARS_PER_PAGE * Math.max(1, pages);
    }

    private static int pageCount(Metadata metadata) {
        String pages = metadata.get("xmpTPg:NPages");
        try {
            return pages == null ? 1 : Integer.parseInt(pages.strip());
        } catch (NumberFormatException e) {
            return 1;
        }
    }

    /**
     * Tika's plain-text parser drops blank lines, but blank lines are the only paragraph
     * markers a .txt file has. So for TXT we use Tika only to detect the character encoding,
     * then decode the bytes and split paragraphs ourselves.
     */
    private static List<Block> plainTextParagraphs(byte[] content, Metadata metadata) {
        String text = new String(content, detectedCharset(metadata));
        if (!text.isEmpty() && text.charAt(0) == '﻿') {
            text = text.substring(1); // byte-order mark
        }
        List<Block> blocks = new ArrayList<>();
        for (String paragraph : BLANK_LINE.split(text)) {
            String cleaned = TextCleaner.cleanParagraph(paragraph);
            if (!cleaned.isEmpty()) {
                blocks.add(Block.paragraph(cleaned, null));
            }
        }
        return blocks;
    }

    private static Charset detectedCharset(Metadata metadata) {
        String name = metadata.get(HttpHeaders.CONTENT_ENCODING);
        try {
            return name == null ? StandardCharsets.UTF_8 : Charset.forName(name);
        } catch (IllegalArgumentException e) {
            return StandardCharsets.UTF_8;
        }
    }

    private static String rootMessage(Throwable e) {
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        return root.getMessage() == null ? root.getClass().getSimpleName() : root.getMessage();
    }
}
