package com.smoi.task;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.smoi.auth.CurrentUser;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Tasks and reminders. The client chooses each id, so {@code PUT} both creates and updates, and
 * repeating a request is harmless (the desktop app retries its offline changes).
 *
 * <ul>
 *   <li>{@code PUT} answers 200 with the row as stored. If a newer change was already stored,
 *       that newer row is returned, and the client replaces its copy.</li>
 *   <li>404: no such row for this user; 410: it was deleted, which always wins.</li>
 * </ul>
 */
@RestController
public class TaskController {

    private final TaskService service;

    public TaskController(TaskService service) {
        this.service = service;
    }

    // ---- tasks -------------------------------------------------------------------------------

    /** {@code ?overdue=true}: only open tasks whose due date has passed (FR-02.06). */
    @GetMapping("/api/tasks")
    public List<TaskResponse> listTasks(@AuthenticationPrincipal Jwt jwt,
                                        @RequestParam(defaultValue = "false") boolean overdue) {
        return service.listTasks(CurrentUser.id(jwt), overdue).stream().map(TaskResponse::from).toList();
    }

    @PutMapping("/api/tasks/{id}")
    public TaskResponse saveTask(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
                                 @Valid @RequestBody TaskRequest r) {
        return TaskResponse.from(service.saveTask(CurrentUser.id(jwt), id, new TaskRepository.Fields(
                r.title().strip(), orEmpty(r.description()), r.priority() == null ? "normal" : r.priority(),
                orEmpty(r.category()).strip(), r.dueAt(), r.completedAt(), r.editedAt())));
    }

    @DeleteMapping("/api/tasks/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteTask(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        service.deleteTask(CurrentUser.id(jwt), id);
    }

    // ---- reminders ---------------------------------------------------------------------------

    @GetMapping("/api/reminders")
    public List<ReminderResponse> listReminders(@AuthenticationPrincipal Jwt jwt) {
        return service.listReminders(CurrentUser.id(jwt)).stream().map(ReminderResponse::from).toList();
    }

    @PutMapping("/api/reminders/{id}")
    public ReminderResponse saveReminder(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
                                         @Valid @RequestBody ReminderRequest r) {
        return ReminderResponse.from(service.saveReminder(CurrentUser.id(jwt), id, new ReminderRepository.Fields(
                r.taskId(), r.title().strip(), r.firstAt(), r.repeat() == null ? "none" : r.repeat(),
                r.weekdays() == null ? 0 : r.weekdays(), r.timeZone(), r.lastFiredAt(), r.editedAt())));
    }

    @DeleteMapping("/api/reminders/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteReminder(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        service.deleteReminder(CurrentUser.id(jwt), id);
    }

    // ---- sync --------------------------------------------------------------------------------

    /**
     * Everything the desktop needs to refresh its local copy: active tasks and reminders, plus
     * those deleted in the last 30 days (with {@code deletedAt} set) so it can drop them.
     */
    @GetMapping("/api/sync")
    public SyncResponse sync(@AuthenticationPrincipal Jwt jwt) {
        TaskService.Changes c = service.changes(CurrentUser.id(jwt));
        return new SyncResponse(c.tasks().stream().map(TaskResponse::from).toList(),
                c.reminders().stream().map(ReminderResponse::from).toList(), Instant.now());
    }

    // ---- errors ------------------------------------------------------------------------------

    @ExceptionHandler(TaskService.NotFoundException.class)
    ProblemDetail notFound(TaskService.NotFoundException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, e.getMessage());
    }

    @ExceptionHandler(TaskService.GoneException.class)
    ProblemDetail gone(TaskService.GoneException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.GONE, e.getMessage());
    }

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail badRequest(IllegalArgumentException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    private static String orEmpty(String s) {
        return s == null ? "" : s;
    }

    // ---- bodies ------------------------------------------------------------------------------

    public record TaskRequest(
            @NotBlank @Size(max = 300) String title,
            @Size(max = 5000) String description,
            @Pattern(regexp = "low|normal|high") String priority,
            @Size(max = 50) String category,
            Instant dueAt,
            Instant completedAt,
            @NotNull Instant editedAt) {
    }

    public record ReminderRequest(
            UUID taskId,
            @NotBlank @Size(max = 300) String title,
            @NotNull Instant firstAt,
            @Pattern(regexp = "none|daily|weekly|monthly|weekdays") String repeat,
            @Min(0) @Max(127) Integer weekdays,
            @NotBlank @Size(max = 64) String timeZone,
            Instant lastFiredAt,
            @NotNull Instant editedAt) {
    }

    public record TaskResponse(UUID id, String title, String description, String priority, String category,
                               Instant dueAt, Instant completedAt, Instant editedAt, Instant createdAt,
                               Instant deletedAt) {
        static TaskResponse from(Task t) {
            return new TaskResponse(t.id(), t.title(), t.description(), t.priority(), t.category(), t.dueAt(),
                    t.completedAt(), t.editedAt(), t.createdAt(), t.deletedAt());
        }
    }

    public record ReminderResponse(UUID id, UUID taskId, String title, Instant firstAt, String repeat, int weekdays,
                                   String timeZone, Instant lastFiredAt, Instant editedAt, Instant deletedAt) {
        static ReminderResponse from(Reminder r) {
            return new ReminderResponse(r.id(), r.taskId(), r.title(), r.firstAt(), r.repeat(), r.weekdays(),
                    r.timeZone(), r.lastFiredAt(), r.editedAt(), r.deletedAt());
        }
    }

    public record SyncResponse(List<TaskResponse> tasks, List<ReminderResponse> reminders, Instant serverTime) {
    }
}
