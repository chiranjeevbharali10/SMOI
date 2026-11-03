package com.smoi.voice;

/**
 * Turns a short recording into text (FR-03.03). Configuration picks the implementation
 * ({@code smoi.stt.provider}); nothing outside this package names one. Implementations must not
 * store or log the audio (NFR-04).
 */
public interface SpeechToText {

    /** {@code whisper}, or {@code none} when voice is not configured. */
    String providerId();

    /**
     * @param audio a complete audio file, for example a 16 kHz mono WAV
     * @throws SpeechToTextUnavailableException if the engine can't be reached or fails
     * @throws IllegalArgumentException         if the audio can't be decoded
     */
    String transcribe(byte[] audio);
}
