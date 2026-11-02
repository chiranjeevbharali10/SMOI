package com.smoi.answer;

import java.util.UUID;

import com.smoi.auth.CurrentUser;
import com.smoi.document.DocumentService;
import com.smoi.llm.ContextOverflowException;
import com.smoi.llm.LlmUnavailableException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Summary and comparison of documents, with citations (FR-06.09). */
@RestController
@RequestMapping("/api/documents")
public class InsightController {

    private final DocumentInsightService insights;

    public InsightController(DocumentInsightService insights) {
        this.insights = insights;
    }

    @PostMapping("/{id}/summary")
    public ResponseEntity<DocumentInsightService.InsightResult> summary(@AuthenticationPrincipal Jwt jwt,
                                                                         @PathVariable UUID id) {
        return respond(insights.summarize(CurrentUser.id(jwt), id));
    }

    public record CompareRequest(@NotNull UUID first, @NotNull UUID second) {
    }

    @PostMapping("/compare")
    public ResponseEntity<DocumentInsightService.InsightResult> compare(@AuthenticationPrincipal Jwt jwt,
                                                                         @Valid @RequestBody CompareRequest request) {
        return respond(insights.compare(CurrentUser.id(jwt), request.first(), request.second()));
    }

    private static ResponseEntity<DocumentInsightService.InsightResult> respond(DocumentInsightService.InsightResult r) {
        return ResponseEntity.status(r.outcome() == AnswerResult.Outcome.CITATION_REJECTED
                ? HttpStatus.BAD_GATEWAY : HttpStatus.OK).body(r);
    }

    @ExceptionHandler(DocumentService.DocumentNotFoundException.class)
    ProblemDetail notFound(DocumentService.DocumentNotFoundException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, e.getMessage());
    }

    @ExceptionHandler(DocumentInsightService.HostedLlmNotAllowedException.class)
    ProblemDetail hostedNotAllowed(DocumentInsightService.HostedLlmNotAllowedException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.FORBIDDEN, e.getMessage());
    }

    @ExceptionHandler(DocumentInsightService.NotIndexedException.class)
    ProblemDetail notIndexed(DocumentInsightService.NotIndexedException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, e.getMessage());
    }

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail badRequest(IllegalArgumentException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    @ExceptionHandler({LlmUnavailableException.class, ContextOverflowException.class})
    ProblemDetail llmUnavailable(RuntimeException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.SERVICE_UNAVAILABLE, e.getMessage());
    }
}
