package com.smoi.voice;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Picks the speech-to-text engine from {@code smoi.stt.provider}. */
@Configuration
public class SpeechToTextConfig {

    @Bean
    @ConditionalOnMissingBean
    SpeechToText speechToText(SpeechToTextProperties props) {
        return switch (props.provider()) {
            case "whisper" -> new WhisperSpeechToText(props);
            case "none" -> new SpeechToText() {
                @Override
                public String providerId() {
                    return "none";
                }

                @Override
                public String transcribe(byte[] audio) {
                    throw new SpeechToTextUnavailableException("Voice isn't set up on the SMOI backend.");
                }
            };
            default -> throw new IllegalStateException("Unknown smoi.stt.provider: " + props.provider());
        };
    }
}
