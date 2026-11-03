package com.smoi.voice;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Settings from {@code smoi.stt.*}.
 *
 * @param provider {@code whisper} (the local sidecar) or {@code none} (voice turned off; the
 *                 transcribe endpoint answers 503 and the desktop says voice isn't set up)
 * @param baseUrl  the sidecar, for example {@code http://localhost:8002}
 * @param timeout  how long one transcription may take
 */
@ConfigurationProperties(prefix = "smoi.stt")
public record SpeechToTextProperties(String provider, String baseUrl, Duration timeout) {
}
