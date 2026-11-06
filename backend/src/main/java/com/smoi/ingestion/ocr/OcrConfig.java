package com.smoi.ingestion.ocr;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Creates the OCR client only when {@code smoi.ocr.enabled=true}. */
@Configuration
public class OcrConfig {

    @Bean
    @ConditionalOnProperty(name = "smoi.ocr.enabled", havingValue = "true")
    OcrClient ocrClient(OcrProperties props) {
        return new HttpOcrClient(props);
    }
}
