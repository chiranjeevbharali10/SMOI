package com.smoi.retrieval.rerank;

public class RerankerUnavailableException extends RuntimeException {

    public RerankerUnavailableException(String message, Throwable cause) {
        super(message, cause);
    }

    public RerankerUnavailableException(String message) {
        super(message);
    }
}
