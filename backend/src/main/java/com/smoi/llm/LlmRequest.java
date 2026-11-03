package com.smoi.llm;

/**
 * @param system        instructions (trusted, written by us)
 * @param user          the user turn: retrieved sources as delimited data, then the question
 * @param deterministic ask for the same output every time (temperature 0, a fixed seed), for
 *                      classification such as command intents. Providers that don't accept
 *                      sampling settings (Claude Haiku 5.5) ignore it.
 */
public record LlmRequest(String system, String user, boolean deterministic) {

    public LlmRequest(String system, String user) {
        this(system, user, false);
    }
}
