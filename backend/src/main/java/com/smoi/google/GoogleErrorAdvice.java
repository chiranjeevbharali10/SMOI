package com.smoi.google;

import java.net.URI;
import java.util.NoSuchElementException;

import com.smoi.actions.GoogleActionService;
import com.smoi.task.TaskService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * How Google errors reach the desktop, for the Google, Gmail, Calendar and actions controllers.
 * Each problem has a {@code code} the desktop acts on; {@code google_reconnect} shows the
 * reconnect banner (FR-05.12). Messages are plain sentences; Google's own error bodies are never passed on.
 */
@RestControllerAdvice(basePackages = {"com.smoi.google", "com.smoi.gmail", "com.smoi.calendar", "com.smoi.actions"})
public class GoogleErrorAdvice {

    @ExceptionHandler(GoogleExceptions.NotConfigured.class)
    ProblemDetail notConfigured(GoogleExceptions.NotConfigured e) {
        return problem(HttpStatus.SERVICE_UNAVAILABLE, "google_not_configured", e.getMessage());
    }

    @ExceptionHandler(GoogleExceptions.NotConnected.class)
    ProblemDetail notConnected(GoogleExceptions.NotConnected e) {
        return problem(HttpStatus.CONFLICT, "google_not_connected", e.getMessage());
    }

    @ExceptionHandler(GoogleExceptions.ReconnectRequired.class)
    ProblemDetail reconnect(GoogleExceptions.ReconnectRequired e) {
        return problem(HttpStatus.CONFLICT, "google_reconnect", e.getMessage());
    }

    @ExceptionHandler(GoogleExceptions.MissingScope.class)
    ProblemDetail scope(GoogleExceptions.MissingScope e) {
        return problem(HttpStatus.FORBIDDEN, "google_missing_scope", e.getMessage());
    }

    @ExceptionHandler(GoogleExceptions.Unavailable.class)
    ProblemDetail unavailable(GoogleExceptions.Unavailable e) {
        return problem(HttpStatus.SERVICE_UNAVAILABLE, "google_unavailable", e.getMessage());
    }

    @ExceptionHandler(GoogleExceptions.ApiError.class)
    ProblemDetail apiError(GoogleExceptions.ApiError e) {
        return problem(HttpStatus.BAD_GATEWAY, "google_error", e.getMessage());
    }

    @ExceptionHandler(GoogleActionService.ActionNotApplicable.class)
    ProblemDetail notApplicable(GoogleActionService.ActionNotApplicable e) {
        return problem(HttpStatus.CONFLICT, "action_not_applicable", e.getMessage());
    }

    @ExceptionHandler({NoSuchElementException.class, TaskService.NotFoundException.class})
    ProblemDetail notFound(RuntimeException e) {
        return problem(HttpStatus.NOT_FOUND, "not_found", "Not found.");
    }

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail badRequest(IllegalArgumentException e) {
        return problem(HttpStatus.BAD_REQUEST, "invalid", e.getMessage());
    }

    private static ProblemDetail problem(HttpStatus status, String code, String detail) {
        ProblemDetail p = ProblemDetail.forStatusAndDetail(status, detail);
        p.setType(URI.create("urn:smoi:" + code));
        p.setProperty("code", code);
        return p;
    }
}
