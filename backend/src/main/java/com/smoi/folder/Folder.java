package com.smoi.folder;

import java.time.Instant;
import java.util.UUID;

/** A folder the user asked SMOI to keep indexed. */
public record Folder(UUID id, UUID userId, String path, Instant createdAt) {
}
