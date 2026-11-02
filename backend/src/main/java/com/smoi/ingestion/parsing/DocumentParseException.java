package com.smoi.ingestion.parsing;

/**
 * The file can't be turned into text: corrupt, password-protected, or contains no text.
 * Retrying won't help, so ingestion moves the job straight to the dead-letter state.
 */
public class DocumentParseException extends RuntimeException {

    public DocumentParseException(String message) {
        super(message);
    }

    public DocumentParseException(String message, Throwable cause) {
        super(message, cause);
    }
}
