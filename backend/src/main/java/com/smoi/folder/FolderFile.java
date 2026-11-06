package com.smoi.folder;

import java.time.Instant;
import java.util.UUID;

/**
 * One file in a watched folder.
 *
 * @param contentHash  SHA-256 of the bytes, or null if the file could not be read or sent
 * @param modifiedTime with {@code sizeBytes}, the desktop's quick check for whether a file changed
 * @param documentId   the indexed document; files with identical content share one
 */
public record FolderFile(UUID id, UUID userId, UUID folderId, String path, String contentHash, Instant modifiedTime,
                         long sizeBytes, String status, String error, UUID documentId, Instant updatedAt) {

    public static final String PENDING = "pending";
    public static final String DONE = "done";
    public static final String FAILED = "failed";
    public static final String NEEDS_OCR = "needs_ocr";
}
