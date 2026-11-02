package com.smoi.answer;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

import com.smoi.document.Chunk;
import com.smoi.document.ChunkRepository;
import com.smoi.document.Document;
import com.smoi.document.DocumentRepository;
import com.smoi.document.DocumentService;
import com.smoi.llm.LlmProvider;
import com.smoi.llm.LlmRequest;
import com.smoi.llm.LlmResult;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Service;

/**
 * Summarises one document or compares two, with citations (FR-06.09).
 *
 * <p>If all chunks fit in the prompt budget, the model sees them directly. If not, a map-reduce
 * runs: each group of chunks that fits is turned into short notes (keeping their [S#] citations),
 * and the final summary or comparison is written from the notes. Every pass's citations are
 * checked against the chunks of the documents involved.
 */
@Service
public class DocumentInsightService {

    private final DocumentRepository documents;
    private final ChunkRepository chunks;
    private final LlmProvider llm;
    private final MeterRegistry metrics;

    public DocumentInsightService(DocumentRepository documents, ChunkRepository chunks, LlmProvider llm,
                                  MeterRegistry metrics) {
        this.documents = documents;
        this.chunks = chunks;
        this.llm = llm;
        this.metrics = metrics;
    }

    public record InsightResult(AnswerResult.Outcome outcome, String text, String message,
                                List<AnswerResult.Citation> citations, List<String> invalidCitations,
                                String refusalCategory, String provider, String model, int passes, long totalMs) {
    }

    public InsightResult summarize(UUID userId, UUID documentId) {
        Document doc = usable(userId, documentId);
        List<Source> sources = sources(List.of(doc), userId);
        return run(Prompts.SUMMARY_SYSTEM, "Summarise the document " + Prompts.escape(doc.filename()) + ".", sources);
    }

    public InsightResult compare(UUID userId, UUID first, UUID second) {
        if (first.equals(second)) {
            throw new IllegalArgumentException("Choose two different documents to compare");
        }
        Document a = usable(userId, first);
        Document b = usable(userId, second);
        List<Source> sources = sources(List.of(a, b), userId);
        return run(Prompts.COMPARE_SYSTEM, "Compare the documents " + Prompts.escape(a.filename()) + " and "
                + Prompts.escape(b.filename()) + ".", sources);
    }

    private Document usable(UUID userId, UUID documentId) {
        Document doc = documents.findActive(userId, documentId).orElseThrow(DocumentService.DocumentNotFoundException::new);
        if (llm.hosted() && !doc.hostedLlmAllowed()) {
            throw new HostedLlmNotAllowedException(doc.filename());
        }
        if (!Document.INDEXED.equals(doc.status())) {
            throw new NotIndexedException(doc.filename(), doc.status());
        }
        return doc;
    }

    private List<Source> sources(List<Document> docs, UUID userId) {
        List<Source> sources = new ArrayList<>();
        for (Document doc : docs) {
            for (Chunk c : chunks.listForDocument(userId, doc.id())) {
                sources.add(Source.of("S" + (sources.size() + 1), c, doc.filename()));
            }
        }
        return sources;
    }

    private InsightResult run(String system, String task, List<Source> sources) {
        long start = System.nanoTime();
        Map<String, Source> byLabel = sources.stream().collect(Collectors.toMap(Source::label, Function.identity(),
                (x, y) -> x, LinkedHashMap::new));
        int budget = llm.maxPromptTokens();
        int passes = 0;

        LlmRequest finalRequest;
        if (Prompts.fits(system, sources, task, budget)) {
            finalRequest = Prompts.withSources(system, sources, task, budget).request();
        } else {
            // Map: notes per group of chunks that fits, never mixing documents in one group.
            StringBuilder notes = new StringBuilder();
            for (List<Source> group : groups(sources, budget)) {
                Prompts.Built built = Prompts.withSources(Prompts.NOTES_SYSTEM, group, "Write notes on these sources.", budget);
                LlmResult partial = llm.generate(built.request(), t -> { });
                passes++;
                InsightResult problem = problem(partial, byLabel, passes, start);
                if (problem != null) {
                    return problem;
                }
                notes.append(Prompts.notesElement(group.getFirst().filename(), partial.text()));
            }
            String user = notes + "\n" + task;
            if (Prompts.estimateTokens(system + user) > budget) {
                throw new com.smoi.llm.ContextOverflowException("The notes for these documents are still too long for one prompt");
            }
            finalRequest = new LlmRequest(system, user);
        }

        LlmResult result = llm.generate(finalRequest, t -> { });
        passes++;
        InsightResult problem = problem(result, byLabel, passes, start);
        if (problem != null) {
            return problem;
        }
        Citations.Check check = Citations.check(result.text(), byLabel.keySet());
        return record(new InsightResult(AnswerResult.Outcome.ANSWERED, result.text().strip(), null,
                check.cited().stream().map(byLabel::get).map(AnswerResult.Citation::of).toList(), List.of(), null,
                llm.providerId(), llm.model(), passes, millisSince(start)));
    }

    /** A refusal or a bad citation in any pass ends the run; returns null when the pass is fine. */
    private InsightResult problem(LlmResult result, Map<String, Source> byLabel, int passes, long start) {
        if (result.stop() == LlmResult.Stop.REFUSAL) {
            return record(new InsightResult(AnswerResult.Outcome.REFUSED, null,
                    "The " + llm.providerId() + " model declined this request"
                            + (result.refusalCategory() != null ? " (category: " + result.refusalCategory() + ")" : "") + ".",
                    List.of(), List.of(), result.refusalCategory(), llm.providerId(), llm.model(), passes, millisSince(start)));
        }
        Citations.Check check = Citations.check(result.text(), byLabel.keySet());
        if (!check.valid() || check.cited().isEmpty()) {
            return record(new InsightResult(AnswerResult.Outcome.CITATION_REJECTED, null,
                    check.valid() ? "The text cited none of the sources." : "The text cited sources it wasn't given: "
                            + String.join(", ", check.invalid()),
                    List.of(), check.invalid(), null, llm.providerId(), llm.model(), passes, millisSince(start)));
        }
        return null;
    }

    /** Splits sources into groups that each fit one notes prompt, keeping each document's chunks separate. */
    private static List<List<Source>> groups(List<Source> sources, int budget) {
        List<List<Source>> groups = new ArrayList<>();
        List<Source> current = new ArrayList<>();
        for (Source s : sources) {
            boolean newDocument = !current.isEmpty() && !current.getFirst().documentId().equals(s.documentId());
            List<Source> candidate = new ArrayList<>(current);
            candidate.add(s);
            if (newDocument || (!current.isEmpty()
                    && !Prompts.fits(Prompts.NOTES_SYSTEM, candidate, "Write notes on these sources.", budget))) {
                groups.add(current);
                current = new ArrayList<>();
            }
            current.add(s);
        }
        if (!current.isEmpty()) {
            groups.add(current);
        }
        return groups;
    }

    private InsightResult record(InsightResult result) {
        metrics.counter("smoi.answers", "outcome", result.outcome().value(),
                "provider", result.provider(), "model", result.model()).increment();
        return result;
    }

    private static long millisSince(long start) {
        return (System.nanoTime() - start) / 1_000_000;
    }

    public static class HostedLlmNotAllowedException extends RuntimeException {
        public HostedLlmNotAllowedException(String filename) {
            super(filename + " isn't allowed to be sent to the hosted LLM. Allow it with PATCH /api/documents/{id} "
                    + "{\"hostedLlmAllowed\": true}, or use a local LLM.");
        }
    }

    public static class NotIndexedException extends RuntimeException {
        public NotIndexedException(String filename, String status) {
            super(filename + " is not indexed yet (status: " + status + ")");
        }
    }
}
