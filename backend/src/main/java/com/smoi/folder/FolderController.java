package com.smoi.folder;

import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import com.smoi.auth.CurrentUser;
import com.smoi.ingestion.ocr.OcrClient;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
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
 * Watched folders. The desktop app is the only caller: it watches the folders on disk and reports
 * each change. See {@link FolderService} for what each change does to the index.
 */
@RestController
@RequestMapping("/api/folders")
public class FolderController {

    private final FolderService service;
    private final boolean ocrEnabled;

    public FolderController(FolderService service, Optional<OcrClient> ocr) {
        this.service = service;
        this.ocrEnabled = ocr.isPresent();
    }

    /** Every folder with its file counts, plus the totals ("142 of 300 indexed, 3 failed"). */
    @GetMapping
    public FoldersResponse list(@AuthenticationPrincipal Jwt jwt) {
        List<FolderResponse> folders = service.listFolders(CurrentUser.id(jwt)).stream().map(FolderResponse::from).toList();
        return new FoldersResponse(folders,
                folders.stream().mapToInt(FolderResponse::total).sum(),
                folders.stream().mapToInt(FolderResponse::done).sum(),
                folders.stream().mapToInt(FolderResponse::pending).sum(),
                folders.stream().mapToInt(FolderResponse::failed).sum(),
                folders.stream().mapToInt(FolderResponse::needsOcr).sum(),
                ocrEnabled);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public FolderResponse add(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody AddFolderRequest request) {
        Folder folder = service.addFolder(CurrentUser.id(jwt), request.path());
        return new FolderResponse(folder.id(), folder.path(), 0, 0, 0, 0, 0);
    }

    /** Stops watching the folder and removes its files from the index. Files on disk are not touched. */
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void remove(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        service.removeFolder(CurrentUser.id(jwt), id);
    }

    /** What the index knows about each file, for the desktop's startup rescan. */
    @GetMapping("/{id}/files")
    public List<FileResponse> files(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return service.listFiles(CurrentUser.id(jwt), id).stream().map(FileResponse::from).toList();
    }

    /** A new or changed file. Unchanged content only updates the stored modified time. */
    @PutMapping(path = "/{id}/files", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public FileResponse sync(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
                             @RequestParam("file") MultipartFile file, @RequestParam("path") String path,
                             @RequestParam("modifiedTime") Instant modifiedTime) throws IOException {
        return FileResponse.from(service.syncFile(CurrentUser.id(jwt), id, path, modifiedTime, file.getBytes()));
    }

    /** A file the desktop could not send, for example because it is too large. */
    @PostMapping("/{id}/files/failed")
    public FileResponse failed(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
                               @Valid @RequestBody FailedRequest request) {
        return FileResponse.from(service.recordFailure(CurrentUser.id(jwt), id, request.path(), request.modifiedTime(),
                request.sizeBytes(), request.error()));
    }

    @PostMapping("/files/touch")
    public FileResponse touch(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody TouchRequest request) {
        return FileResponse.from(service.touchFile(CurrentUser.id(jwt), request.path(), request.modifiedTime(),
                request.sizeBytes()));
    }

    @PostMapping("/files/move")
    public FileResponse move(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody MoveRequest request) {
        return FileResponse.from(service.moveFile(CurrentUser.id(jwt), request.fromPath(), request.toFolderId(),
                request.toPath()));
    }

    /** The file is gone from disk. Removes it from the index. */
    @PostMapping("/files/delete")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody DeleteRequest request) {
        service.deleteFile(CurrentUser.id(jwt), request.path());
    }

    /** Indexes needs-OCR files again. Only when the OCR sidecar is enabled. */
    @PostMapping("/retry-ocr")
    public RetryResponse retryOcr(@AuthenticationPrincipal Jwt jwt) {
        if (!ocrEnabled) {
            throw new OcrDisabledException();
        }
        return new RetryResponse(service.retryNeedsOcr(CurrentUser.id(jwt)));
    }

    // ---------- requests and responses ----------

    public record AddFolderRequest(@NotBlank @Size(max = 1024) String path) {
    }

    public record FailedRequest(@NotBlank @Size(max = 1024) String path, @NotNull Instant modifiedTime,
                                @PositiveOrZero long sizeBytes, @Size(max = 2000) String error) {
    }

    public record TouchRequest(@NotBlank @Size(max = 1024) String path, @NotNull Instant modifiedTime,
                               @PositiveOrZero long sizeBytes) {
    }

    public record MoveRequest(@NotBlank @Size(max = 1024) String fromPath, @NotNull UUID toFolderId,
                              @NotBlank @Size(max = 1024) String toPath) {
    }

    public record DeleteRequest(@NotBlank @Size(max = 1024) String path) {
    }

    public record RetryResponse(int queued) {
    }

    public record FoldersResponse(List<FolderResponse> folders, int total, int done, int pending, int failed,
                                  int needsOcr, boolean ocrEnabled) {
    }

    public record FolderResponse(UUID id, String path, int total, int done, int pending, int failed, int needsOcr) {

        static FolderResponse from(FolderService.FolderSummary s) {
            return new FolderResponse(s.folder().id(), s.folder().path(), s.total(), s.done(), s.pending(), s.failed(),
                    s.needsOcr());
        }
    }

    public record FileResponse(UUID id, UUID folderId, String path, String contentHash, Instant modifiedTime,
                               long sizeBytes, String status, String error, UUID documentId) {

        static FileResponse from(FolderFile f) {
            return new FileResponse(f.id(), f.folderId(), f.path(), f.contentHash(), f.modifiedTime(), f.sizeBytes(),
                    f.status(), f.error(), f.documentId());
        }
    }

    // ---------- errors ----------

    public static class OcrDisabledException extends RuntimeException {
        public OcrDisabledException() {
            super("OCR is off. Start the OCR sidecar and set OCR_ENABLED=true first.");
        }
    }

    @ExceptionHandler({FolderService.FolderNotFoundException.class, FolderService.FileNotFoundException.class})
    ProblemDetail notFound(RuntimeException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, e.getMessage());
    }

    @ExceptionHandler({FolderService.FolderOverlapException.class, OcrDisabledException.class})
    ProblemDetail conflict(RuntimeException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, e.getMessage());
    }

    @ExceptionHandler(FolderService.InvalidPathException.class)
    ProblemDetail badPath(FolderService.InvalidPathException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, e.getMessage());
    }
}
