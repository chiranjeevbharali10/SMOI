package com.smoi.voice;

import java.net.http.HttpClient;

import com.smoi.resilience.ProviderTimeouts;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/**
 * Calls the local faster-whisper sidecar ({@code sidecars/whisper}): {@code POST /transcribe}
 * with the audio as the request body. The audio only passes through memory.
 */
public class WhisperSpeechToText implements SpeechToText {

    private final RestClient http;

    public WhisperSpeechToText(SpeechToTextProperties props) {
        HttpClient client = HttpClient.newBuilder().connectTimeout(ProviderTimeouts.CONNECT).build();
        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(client);
        requestFactory.setReadTimeout(props.timeout());
        this.http = RestClient.builder().baseUrl(props.baseUrl()).requestFactory(requestFactory).build();
    }

    @Override
    public String providerId() {
        return "whisper";
    }

    @Override
    public String transcribe(byte[] audio) {
        Transcript t;
        try {
            t = http.post().uri("/transcribe")
                    .contentType(MediaType.APPLICATION_OCTET_STREAM)
                    .body(audio)
                    .retrieve()
                    .onStatus(s -> s.value() == 400, (req, res) -> {
                        throw new IllegalArgumentException("The recording couldn't be decoded.");
                    })
                    .onStatus(HttpStatusCode::isError, (req, res) -> {
                        throw new SpeechToTextUnavailableException("Speech-to-text failed with HTTP " + res.getStatusCode().value());
                    })
                    .body(Transcript.class);
        } catch (RestClientException e) {
            throw new SpeechToTextUnavailableException("Speech-to-text can't be reached: " + e.getMessage(), e);
        }
        if (t == null || t.text() == null) {
            throw new SpeechToTextUnavailableException("Speech-to-text returned no text");
        }
        return t.text().strip();
    }

    record Transcript(String model, String text, String language, double durationSeconds) {
    }
}
