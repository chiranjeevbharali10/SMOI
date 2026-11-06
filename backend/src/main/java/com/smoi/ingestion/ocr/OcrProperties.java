package com.smoi.ingestion.ocr;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Settings from {@code smoi.ocr.*}.
 *
 * @param enabled whether the OCR sidecar ({@code sidecars/ocr}) is configured. When false,
 *                scanned PDFs stop at "needs OCR".
 * @param baseUrl the sidecar, for example {@code http://localhost:8003}
 * @param timeout how long one PDF may take; OCR runs about a second or more per page on CPU
 */
@ConfigurationProperties(prefix = "smoi.ocr")
public record OcrProperties(boolean enabled, String baseUrl, Duration timeout) {
}
