package com.smoi.answer;

import java.util.List;
import java.util.UUID;

import com.smoi.retrieval.RetrievalMode;

/**
 * The outcome of a question.
 *
 * @param outcome            see {@link Outcome}
 * @param answer             the answer text; null when the answer was rejected
 * @param citations          the sources the answer cites, resolved to chunks and locations
 * @param invalidCitations   for {@link Outcome#CITATION_REJECTED}: the fabricated citations
 * @param refusalCategory    for {@link Outcome#REFUSED}: the provider's category
 * @param excludedDocuments  documents not searched because they aren't allowed for a hosted LLM
 * @param omittedForContext  retrieved chunks left out because the prompt budget was full
 * @param truncated          the answer hit the output token limit
 * @param passages           only for {@link Outcome#LLM_UNAVAILABLE}: the retrieved passages
 */
public record AnswerResult(
        Outcome outcome,
        String answer,
        String message,
        List<Citation> citations,
        List<String> invalidCitations,
        String refusalCategory,
        String provider,
        String model,
        RetrievalMode mode,
        String rerank,
        String rerankNote,
        int sourcesGiven,
        int excludedDocuments,
        int omittedForContext,
        boolean truncated,
        Timings timings,
        List<Passage> passages) {

    public enum Outcome {
        /** An answer with valid citations. */
        ANSWERED,
        /** The sources don't cover the question. */
        DONT_KNOW,
        /** The provider's safety system declined. Counted separately; it is not an answer. */
        REFUSED,
        /** The model cited something it wasn't given, or cited nothing. The answer is withheld. */
        CITATION_REJECTED,
        /**
         * The LLM is down (or its circuit breaker is open). No answer was generated; the response
         * carries the retrieved passages instead, so the user still gets something useful.
         */
        LLM_UNAVAILABLE;

        @com.fasterxml.jackson.annotation.JsonValue
        public String value() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }

    public record Citation(String label, UUID chunkId, UUID documentId, String filename, int chunkIndex,
                           Integer pageStart, Integer pageEnd, String section) {

        static Citation of(Source s) {
            return new Citation(s.label(), s.chunkId(), s.documentId(), s.filename(), s.chunkIndex(), s.pageStart(),
                    s.pageEnd(), s.section());
        }
    }

    /**
     * A retrieved passage returned as-is, only when the LLM is unavailable. The text is the
     * user's own document content, shown to its owner.
     */
    public record Passage(String label, UUID chunkId, UUID documentId, String filename, int chunkIndex,
                          Integer pageStart, Integer pageEnd, String section, String content) {

        static Passage of(Source s) {
            return new Passage(s.label(), s.chunkId(), s.documentId(), s.filename(), s.chunkIndex(), s.pageStart(),
                    s.pageEnd(), s.section(), s.content());
        }
    }

    /** Milliseconds per stage. {@code firstTokenMs} is from the start of generation. */
    public record Timings(long embedMs, long keywordMs, long vectorMs, long rerankMs, long retrievalMs,
                          long firstTokenMs, long generationMs, long totalMs) {
    }
}
