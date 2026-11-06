package com.smoi.ingestion.ocr;

import java.util.List;

/**
 * Reads the text of a scanned PDF from its page images. Optional: it exists only when
 * {@code smoi.ocr.enabled=true}, so callers inject {@code Optional<OcrClient>}.
 */
public interface OcrClient {

    /** The text of each page, in page order (index 0 is page 1). A page with no text is an empty string. */
    List<String> recognise(byte[] pdf);
}
