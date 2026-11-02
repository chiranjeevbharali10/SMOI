package com.smoi.answer;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.stream.Collectors;

import com.smoi.answer.AnswerResult.Outcome;
import com.smoi.document.DocumentRepository;
import com.smoi.llm.LlmProvider;
import com.smoi.llm.LlmResult;
import com.smoi.retrieval.RetrievalMode;
import com.smoi.retrieval.RetrievalResult;
import com.smoi.retrieval.RetrievalService;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Service;

/**
 * Answers a question from the user's documents: retrieve, build a grounded prompt, generate,
 * check the citations.
 */
@Service
public class AnswerService {

    private final RetrievalService retrieval;
    private final LlmProvider llm;
    private final DocumentRepository documents;
    private final MeterRegistry metrics;

    public AnswerService(RetrievalService retrieval, LlmProvider llm, DocumentRepository documents,
                         MeterRegistry metrics) {
        this.retrieval = retrieval;
        this.llm = llm;
        this.documents = documents;
        this.metrics = metrics;
    }

    /**
     * @param onSources called once with the sources the model will see, before generation starts
     * @param onText    called with answer text as it is generated
     */
    public AnswerResult answer(UUID userId, String question, RetrievalMode mode, int topK,
                               Consumer<List<Source>> onSources, Consumer<String> onText) {
        long start = System.nanoTime();
        // A hosted provider only ever sees documents the user allowed for it (NFR-04.05).
        boolean hostedOnly = llm.hosted();
        int excluded = hostedOnly ? documents.countNotAllowedForHostedLlm(userId) : 0;

        RetrievalResult retrieved = retrieval.retrieve(userId, question, mode, topK, hostedOnly);
        List<Source> candidates = new java.util.ArrayList<>();
        for (int i = 0; i < retrieved.chunks().size(); i++) {
            candidates.add(Source.of("S" + (i + 1), retrieved.chunks().get(i)));
        }

        if (candidates.isEmpty()) {
            // Nothing to ground an answer on: don't ask the model at all.
            onSources.accept(List.of());
            return record(new AnswerResult(Outcome.DONT_KNOW, Prompts.DONT_KNOW,
                    excluded > 0 ? excluded + " of your documents aren't allowed for the hosted LLM and weren't searched."
                            : "No matching passages were found in your documents.",
                    List.of(), List.of(), null, llm.providerId(), llm.model(), mode, retrieved.rerank(),
                    retrieved.rerankNote(), 0, excluded, 0, false,
                    timings(retrieved, 0, 0, start)));
        }

        Prompts.Built prompt = Prompts.withSources(Prompts.ANSWER_SYSTEM, candidates, Prompts.question(question),
                llm.maxPromptTokens());
        onSources.accept(prompt.included());
        LlmResult result = llm.generate(prompt.request(), onText);
        return record(evaluate(result, prompt, retrieved, mode, excluded, start));
    }

    private AnswerResult evaluate(LlmResult result, Prompts.Built prompt, RetrievalResult retrieved, RetrievalMode mode,
                                  int excluded, long start) {
        AnswerResult.Timings timings = timings(retrieved, result.firstTokenMs(), result.totalMs(), start);
        if (result.stop() == LlmResult.Stop.REFUSAL) {
            String message = "The " + llm.providerId() + " model declined to answer this request"
                    + (result.refusalCategory() != null ? " (category: " + result.refusalCategory() + ")" : "")
                    + ". This is a refusal by the provider's safety system, not an answer.";
            return new AnswerResult(Outcome.REFUSED, null, message, List.of(), List.of(), result.refusalCategory(),
                    llm.providerId(), llm.model(), mode, retrieved.rerank(), retrieved.rerankNote(),
                    prompt.included().size(), excluded, prompt.omitted(), false, timings);
        }
        if (Citations.isDontKnow(result.text())) {
            return new AnswerResult(Outcome.DONT_KNOW, Prompts.DONT_KNOW, "Your documents don't cover this question.",
                    List.of(), List.of(), null, llm.providerId(), llm.model(), mode, retrieved.rerank(),
                    retrieved.rerankNote(), prompt.included().size(), excluded, prompt.omitted(), false, timings);
        }
        Map<String, Source> byLabel = prompt.included().stream()
                .collect(Collectors.toMap(Source::label, Function.identity()));
        Citations.Check check = Citations.check(result.text(), byLabel.keySet());
        boolean truncated = result.stop() == LlmResult.Stop.MAX_TOKENS;
        if (!check.valid() || check.cited().isEmpty()) {
            String why = check.valid()
                    ? "The answer cited none of the sources, so it can't be checked."
                    : "The answer cited sources that weren't retrieved for this question: " + String.join(", ", check.invalid());
            return new AnswerResult(Outcome.CITATION_REJECTED, null, why, List.of(), check.invalid(), null,
                    llm.providerId(), llm.model(), mode, retrieved.rerank(), retrieved.rerankNote(),
                    prompt.included().size(), excluded, prompt.omitted(), truncated, timings);
        }
        List<AnswerResult.Citation> citations = check.cited().stream().map(byLabel::get).map(AnswerResult.Citation::of).toList();
        return new AnswerResult(Outcome.ANSWERED, result.text().strip(), null, citations, List.of(), null,
                llm.providerId(), llm.model(), mode, retrieved.rerank(), retrieved.rerankNote(),
                prompt.included().size(), excluded, prompt.omitted(), truncated, timings);
    }

    /** Counts every outcome per provider and model, so refusals and rejected citations are visible as their own rates. */
    private AnswerResult record(AnswerResult result) {
        metrics.counter("smoi.answers", "outcome", result.outcome().value(),
                "provider", result.provider(), "model", result.model()).increment();
        return result;
    }

    private static AnswerResult.Timings timings(RetrievalResult r, long firstTokenMs, long generationMs, long start) {
        RetrievalResult.Timings t = r.timings();
        return new AnswerResult.Timings(t.embedMs(), t.keywordMs(), t.vectorMs(), t.rerankMs(), t.totalMs(),
                firstTokenMs, generationMs, (System.nanoTime() - start) / 1_000_000);
    }
}
