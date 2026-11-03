package com.smoi.command;

import java.time.DateTimeException;
import java.time.ZoneId;

import com.smoi.llm.LlmUnavailableException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST /api/commands/interpret}: what a typed or spoken command means. It only answers
 * with a {@link Proposal}; it never creates, changes or deletes anything. Rate-limited with
 * the query bucket, because it calls the LLM.
 */
@RestController
public class CommandController {

    private final CommandService service;

    public CommandController(CommandService service) {
        this.service = service;
    }

    public record InterpretRequest(@NotBlank @Size(max = CommandService.MAX_COMMAND) String text,
                                   @NotBlank @Size(max = 64) String timeZone) {
    }

    @PostMapping("/api/commands/interpret")
    public Proposal interpret(@Valid @RequestBody InterpretRequest request) {
        ZoneId zone;
        try {
            zone = ZoneId.of(request.timeZone());
        } catch (DateTimeException e) {
            throw new IllegalArgumentException("Unknown time zone: " + request.timeZone());
        }
        return service.interpret(request.text(), zone);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail badRequest(IllegalArgumentException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    @ExceptionHandler(LlmUnavailableException.class)
    ProblemDetail llmUnavailable(LlmUnavailableException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.SERVICE_UNAVAILABLE,
                "The language model is unavailable, so SMOI can't understand commands right now.");
    }
}
