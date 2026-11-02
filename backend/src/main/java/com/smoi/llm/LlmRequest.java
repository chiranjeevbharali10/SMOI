package com.smoi.llm;

/**
 * @param system instructions (trusted, written by us)
 * @param user   the user turn: retrieved sources as delimited data, then the question
 */
public record LlmRequest(String system, String user) {
}
