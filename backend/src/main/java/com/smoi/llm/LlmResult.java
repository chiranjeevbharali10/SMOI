package com.smoi.llm;

/**
 * @param stop               why generation ended
 * @param refusalCategory    only for {@link Stop#REFUSAL}: the provider's category (for example "cyber"), or null
 * @param refusalExplanation only for {@link Stop#REFUSAL}: the provider's explanation, or null
 */
public record LlmResult(String text, Stop stop, String refusalCategory, String refusalExplanation,
                        long inputTokens, long outputTokens, long firstTokenMs, long totalMs) {

    public enum Stop {
        /** The model finished its answer. */
        COMPLETE,
        /** The output limit cut the answer off. */
        MAX_TOKENS,
        /**
         * The provider's safety system declined the request. Claude reports this as HTTP 200 with
         * {@code stop_reason: "refusal"}, so it must be checked explicitly, not treated as an answer.
         */
        REFUSAL
    }
}
