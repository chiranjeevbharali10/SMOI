package com.smoi.answer;

import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.smoi.auth.CurrentUser;
import com.smoi.llm.ContextOverflowException;
import com.smoi.llm.LlmUnavailableException;
import com.smoi.observability.RequestIds;
import com.smoi.retrieval.RetrievalMode;
import jakarta.annotation.PreDestroy;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/** Questions answered from SMOI Brain, with citations (FR-06.06 to FR-06.08, FR-06.12). */
@RestController
@RequestMapping("/api/query")
public class QueryController {

    private static final Logger log = LoggerFactory.getLogger(QueryController.class);
    private static final RetrievalMode DEFAULT_MODE = RetrievalMode.HYBRID;
    private static final int DEFAULT_TOP_K = 6;

    private final AnswerService answers;
    /** Streaming answers run here, so the request thread is free while the model writes. */
    private final ExecutorService streams = Executors.newVirtualThreadPerTaskExecutor();

    public QueryController(AnswerService answers) {
        this.answers = answers;
    }

    public record QueryRequest(@NotBlank @Size(max = 2000) String question, RetrievalMode mode,
                               @Min(1) @Max(20) Integer topK) {

        RetrievalMode modeOrDefault() {
            return mode == null ? DEFAULT_MODE : mode;
        }

        int topKOrDefault() {
            return topK == null ? DEFAULT_TOP_K : topK;
        }
    }

    /**
     * 200 with outcome {@code answered}, {@code dont_know} or {@code refused}. 502 with outcome
     * {@code citation_rejected} when the model cited something it wasn't given: the answer text is
     * withheld, because it can't be trusted.
     */
    @PostMapping
    public ResponseEntity<AnswerResult> query(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody QueryRequest request) {
        AnswerResult result = answers.answer(CurrentUser.id(jwt), request.question(), request.modeOrDefault(),
                request.topKOrDefault(), sources -> { }, text -> { });
        HttpStatus status = result.outcome() == AnswerResult.Outcome.CITATION_REJECTED ? HttpStatus.BAD_GATEWAY : HttpStatus.OK;
        return ResponseEntity.status(status).body(result);
    }

    /**
     * The same, as server-sent events:
     * <ol>
     *   <li>{@code sources}: the passages the model is given</li>
     *   <li>{@code delta}: answer text as it is written (zero or more)</li>
     *   <li>{@code result}: the final result, as from {@code POST /api/query}; or {@code error}</li>
     * </ol>
     * Text arrives before its citations are checked. A client must wait for {@code result} and
     * discard the streamed text if the outcome is {@code citation_rejected} or {@code refused}.
     */
    @PostMapping(path = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody QueryRequest request) {
        UUID userId = CurrentUser.id(jwt); // read on the request thread; the token isn't available later
        String requestId = RequestIds.current(); // the MDC is per thread, so carry the id across
        SseEmitter emitter = new SseEmitter(300_000L);
        streams.submit(() -> {
            try (var ignored = RequestIds.bind(requestId)) {
                AnswerResult result = answers.answer(userId, request.question(), request.modeOrDefault(),
                        request.topKOrDefault(),
                        sources -> send(emitter, "sources", sources.stream().map(AnswerResult.Citation::of).toList()),
                        text -> send(emitter, "delta", Map.of("text", text)));
                send(emitter, "result", result);
                emitter.complete();
            } catch (LlmUnavailableException | ContextOverflowException e) {
                send(emitter, "error", Map.of("status", 503, "detail", e.getMessage()));
                emitter.complete();
            } catch (RuntimeException e) {
                log.error("Streaming answer failed", e);
                send(emitter, "error", Map.of("status", 500, "detail", "Internal error"));
                emitter.complete();
            }
        });
        return emitter;
    }

    private static void send(SseEmitter emitter, String event, Object data) {
        try {
            emitter.send(SseEmitter.event().name(event).data(data, MediaType.APPLICATION_JSON));
        } catch (IOException e) {
            throw new IllegalStateException("Client disconnected", e);
        }
    }

    @ExceptionHandler(LlmUnavailableException.class)
    ProblemDetail llmUnavailable(LlmUnavailableException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.SERVICE_UNAVAILABLE, e.getMessage());
    }

    @ExceptionHandler(ContextOverflowException.class)
    ProblemDetail contextOverflow(ContextOverflowException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.SERVICE_UNAVAILABLE, e.getMessage());
    }

    @PreDestroy
    void shutdown() {
        streams.shutdownNow();
    }
}
