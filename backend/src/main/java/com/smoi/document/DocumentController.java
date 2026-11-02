package com.smoi.document;

import java.io.IOException;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.smoi.auth.CurrentUser;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * SMOI Brain documents. A request for another user's document gets the same 404 as a request
 * for a document that doesn't exist, so ids can't be probed (NFR-03.04).
 */
@RestController
@RequestMapping("/api/documents")
public class DocumentController {

    private final DocumentService service;

    public DocumentController(DocumentService service) {
        this.service = service;
    }

    /**
     * Upload a PDF, DOCX or TXT file. Returns at once: 202 Accepted with status "queued" for a
     * new document, or 200 OK with the existing document if the user already uploaded this
     * exact file. Poll {@code GET /api/documents/{id}} for progress.
     */
    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<DocumentResponse> upload(@AuthenticationPrincipal Jwt jwt,
                                                   @RequestParam("file") MultipartFile file) throws IOException {
        DocumentService.UploadResult result = service.upload(CurrentUser.id(jwt), file.getOriginalFilename(), file.getBytes());
        DocumentResponse body = DocumentResponse.from(result.document());
        if (!result.created()) {
            return ResponseEntity.ok(body);
        }
        return ResponseEntity.accepted().location(URI.create("/api/documents/" + body.id())).body(body);
    }

    @GetMapping
    public List<DocumentResponse> list(@AuthenticationPrincipal Jwt jwt) {
        return service.list(CurrentUser.id(jwt)).stream().map(DocumentResponse::from).toList();
    }

    @GetMapping("/{id}")
    public DocumentResponse get(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return DocumentResponse.from(service.get(CurrentUser.id(jwt), id));
    }

    /** The document's chunks with their source locations, in order. */
    @GetMapping("/{id}/chunks")
    public List<ChunkResponse> chunks(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return service.chunks(CurrentUser.id(jwt), id).stream().map(ChunkResponse::from).toList();
    }

    /**
     * Replace the document's file and re-index it. The current chunks stay searchable until the
     * new ones replace them. 202 if a re-index was queued, 200 if the file is unchanged.
     */
    @PutMapping(path = "/{id}/file", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<DocumentResponse> replace(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
                                                    @RequestParam("file") MultipartFile file) throws IOException {
        DocumentService.UploadResult result = service.replace(CurrentUser.id(jwt), id, file.getOriginalFilename(), file.getBytes());
        DocumentResponse body = DocumentResponse.from(result.document());
        return result.created() ? ResponseEntity.accepted().body(body) : ResponseEntity.ok(body);
    }

    /**
     * Change a document's settings. {@code hostedLlmAllowed}: whether its text may be sent to a
     * hosted (cloud) LLM. Off by default; with a local LLM it has no effect.
     */
    @PatchMapping("/{id}")
    public DocumentResponse update(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
                                   @Valid @RequestBody UpdateRequest request) {
        return DocumentResponse.from(service.setHostedLlmAllowed(CurrentUser.id(jwt), id, request.hostedLlmAllowed()));
    }

    public record UpdateRequest(@NotNull Boolean hostedLlmAllowed) {
    }

    /** Deletes the document and all its chunks and vectors. */
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        service.delete(CurrentUser.id(jwt), id);
    }

    @ExceptionHandler(DocumentService.DocumentNotFoundException.class)
    ProblemDetail notFound(DocumentService.DocumentNotFoundException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, e.getMessage());
    }

    @ExceptionHandler(DocumentService.EmptyFileException.class)
    ProblemDetail empty(DocumentService.EmptyFileException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    @ExceptionHandler(DocumentService.UnsupportedFileTypeException.class)
    ProblemDetail unsupported(DocumentService.UnsupportedFileTypeException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.UNSUPPORTED_MEDIA_TYPE, e.getMessage());
    }

    @ExceptionHandler(DocumentService.DuplicateContentException.class)
    ProblemDetail duplicate(DocumentService.DuplicateContentException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, e.getMessage());
    }

    public record DocumentResponse(UUID id, String filename, String mediaType, long sizeBytes, String status,
                                   String error, int chunkCount, int version, Instant createdAt, Instant updatedAt,
                                   Instant indexedAt, boolean hostedLlmAllowed) {

        static DocumentResponse from(Document d) {
            return new DocumentResponse(d.id(), d.filename(), d.mediaType(), d.sizeBytes(), d.status(), d.error(),
                    d.chunkCount(), d.version(), d.createdAt(), d.updatedAt(), d.indexedAt(),
                    d.hostedLlmAllowed());
        }
    }

    public record ChunkResponse(UUID id, int index, String content, Integer pageStart, Integer pageEnd,
                                String section, int tokenCount, String embeddingModel) {

        static ChunkResponse from(Chunk c) {
            return new ChunkResponse(c.id(), c.chunkIndex(), c.content(), c.pageStart(), c.pageEnd(), c.section(),
                    c.tokenCount(), c.embeddingModel());
        }
    }
}
