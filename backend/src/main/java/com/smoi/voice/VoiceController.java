package com.smoi.voice;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST /api/voice/transcribe}: the recording as the request body (WebM/Opus from the desktop recorder, or WAV),
 * answered with {@code {"text": "..."}}. The audio is neither stored nor logged (NFR-04); only
 * its size is logged. Rate-limited with the query bucket.
 */
@RestController
public class VoiceController {

    /** 60 s of 16 kHz 16-bit mono WAV is about 1.9 MB; the desktop stops recording at 30 s. */
    static final int MAX_AUDIO_BYTES = 4 * 1024 * 1024;
    private static final Logger log = LoggerFactory.getLogger(VoiceController.class);

    private final SpeechToText stt;

    public VoiceController(SpeechToText stt) {
        this.stt = stt;
    }

    public record TranscribeResponse(String text) {
    }

    @PostMapping(path = "/api/voice/transcribe", consumes = {"audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "application/octet-stream"})
    public TranscribeResponse transcribe(@RequestBody byte[] audio) {
        if (audio.length == 0) {
            throw new IllegalArgumentException("No audio was sent.");
        }
        if (audio.length > MAX_AUDIO_BYTES) {
            throw new TooLongException();
        }
        log.debug("Transcribing {} bytes of audio", audio.length);
        return new TranscribeResponse(stt.transcribe(audio));
    }

    static class TooLongException extends RuntimeException {
    }

    @ExceptionHandler(TooLongException.class)
    ProblemDetail tooLong() {
        return ProblemDetail.forStatusAndDetail(HttpStatus.CONTENT_TOO_LARGE, "The recording is too long.");
    }

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail badRequest(IllegalArgumentException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    @ExceptionHandler(SpeechToTextUnavailableException.class)
    ProblemDetail unavailable(SpeechToTextUnavailableException e) {
        log.warn("Speech-to-text unavailable: {}", e.getMessage());
        return ProblemDetail.forStatusAndDetail(HttpStatus.SERVICE_UNAVAILABLE,
                "Speech-to-text isn't available, so SMOI can't hear you right now. You can type instead.");
    }
}
