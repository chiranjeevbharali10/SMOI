package com.smoi.voice;

/** The speech-to-text engine is not configured, can't be reached, or failed. */
public class SpeechToTextUnavailableException extends RuntimeException {

    public SpeechToTextUnavailableException(String message) {
        super(message);
    }

    public SpeechToTextUnavailableException(String message, Throwable cause) {
        super(message, cause);
    }
}
