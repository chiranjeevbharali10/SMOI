package com.smoi.ingestion.parsing;

/**
 * One structural piece of a document: a heading or a paragraph of cleaned text.
 *
 * @param headingLevel 1 to 6 for a heading ({@code <h1>} to {@code <h6>}), 0 for a paragraph
 * @param text         cleaned text on a single line
 * @param page         1-based page number for PDFs, {@code null} for formats without pages
 */
public record Block(int headingLevel, String text, Integer page) {

    public static Block heading(int level, String text, Integer page) {
        return new Block(level, text, page);
    }

    public static Block paragraph(String text, Integer page) {
        return new Block(0, text, page);
    }

    public boolean isHeading() {
        return headingLevel > 0;
    }
}
