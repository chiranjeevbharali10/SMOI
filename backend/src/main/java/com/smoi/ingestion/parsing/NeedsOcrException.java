package com.smoi.ingestion.parsing;

/**
 * A PDF with little or no extractable text, most likely a scan. Without OCR it can't be indexed,
 * so ingestion stops (no retries) and folder sync shows the file as {@code needs_ocr}. With the
 * OCR sidecar turned on, ingestion reads the text from the page images instead.
 */
public class NeedsOcrException extends DocumentParseException {

    /** Every message contains this, so a stored error can be recognised as "needs OCR". */
    public static final String MARKER = "needs OCR";

    public NeedsOcrException(String message) {
        super(message);
    }
}
