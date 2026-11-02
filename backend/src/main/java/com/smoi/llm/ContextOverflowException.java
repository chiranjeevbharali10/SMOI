package com.smoi.llm;

/**
 * The prompt was longer than the model's context. Raised instead of letting the provider cut
 * the prompt, because a cut prompt silently loses retrieved sources or instructions.
 */
public class ContextOverflowException extends RuntimeException {

    public ContextOverflowException(String message) {
        super(message);
    }
}
