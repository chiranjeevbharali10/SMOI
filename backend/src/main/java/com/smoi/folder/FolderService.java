package com.smoi.folder;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

import com.smoi.document.Document;
import com.smoi.document.DocumentRepository;
import com.smoi.document.DocumentService;
import com.smoi.ingestion.JobQueue;
import com.smoi.ingestion.parsing.NeedsOcrException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Keeps the index in step with the user's watched folders. The desktop app reports what it saw
 * on disk (a file's bytes, or that it was renamed, moved or deleted), and this service decides
 * what that means for the index:
 *
 * <ul>
 *   <li>New or edited content: stored and queued for indexing at background priority. An edit
 *       re-indexes the same document, so its old chunks stay searchable until the new ones land.</li>
 *   <li>Same content at the same path (only the modified time changed): metadata only.</li>
 *   <li>Rename or move: the path changes, nothing is re-indexed.</li>
 *   <li>Delete: the file's row goes, and its document (chunks and vectors) goes too unless another
 *       file still has that content or the user uploaded it by hand.</li>
 * </ul>
 *
 * <p>Lock order: document rows first, then {@code folder_files} rows, the same order the
 * ingestion worker uses when it records a result, so the two can't deadlock.
 */
@Service
public class FolderService {

    /** C:\..., \\server\share\..., or /... */
    private static final Pattern ABSOLUTE = Pattern.compile("^([A-Za-z]:[\\\\/]|\\\\\\\\|/).*");
    private static final int MAX_PATH_LENGTH = 1024;

    private final FolderRepository folders;
    private final DocumentRepository documentRows;
    private final DocumentService documents;
    private final JobQueue jobs;

    public FolderService(FolderRepository folders, DocumentRepository documentRows, DocumentService documents,
                         JobQueue jobs) {
        this.folders = folders;
        this.documentRows = documentRows;
        this.documents = documents;
        this.jobs = jobs;
    }

    /** A folder with its files counted by status. */
    public record FolderSummary(Folder folder, int total, int done, int pending, int failed, int needsOcr) {
    }

    // ---------- folders ----------

    @Transactional
    public Folder addFolder(UUID userId, String rawPath) {
        String path = cleanFolderPath(rawPath);
        for (Folder existing : folders.listFolders(userId)) {
            if (isInside(existing.path(), path) || isInside(path, existing.path()) || samePath(existing.path(), path)) {
                throw new FolderOverlapException(existing.path());
            }
        }
        try {
            return folders.insertFolder(userId, path);
        } catch (DuplicateKeyException e) {
            throw new FolderOverlapException(path);
        }
    }

    public List<FolderSummary> listFolders(UUID userId) {
        Map<UUID, Map<String, Integer>> counts = folders.countsByFolder(userId);
        return folders.listFolders(userId).stream().map(f -> {
            Map<String, Integer> c = counts.getOrDefault(f.id(), Map.of());
            int done = c.getOrDefault(FolderFile.DONE, 0);
            int pending = c.getOrDefault(FolderFile.PENDING, 0);
            int failed = c.getOrDefault(FolderFile.FAILED, 0);
            int needsOcr = c.getOrDefault(FolderFile.NEEDS_OCR, 0);
            return new FolderSummary(f, done + pending + failed + needsOcr, done, pending, failed, needsOcr);
        }).toList();
    }

    public List<FolderFile> listFiles(UUID userId, UUID folderId) {
        requireFolder(userId, folderId);
        return folders.listFiles(userId, folderId);
    }

    /** Stops watching a folder and removes its files from the index. Nothing on disk is touched. */
    @Transactional
    public void removeFolder(UUID userId, UUID folderId) {
        requireFolder(userId, folderId);
        List<FolderFile> files = folders.listFiles(userId, folderId);
        Set<UUID> docs = new LinkedHashSet<>();
        files.forEach(f -> {
            if (f.documentId() != null) {
                docs.add(f.documentId());
            }
        });
        docs.forEach(d -> documentRows.lockActive(userId, d));
        files.forEach(f -> folders.softDeleteFile(userId, f.id()));
        folders.softDeleteFolder(userId, folderId);
        docs.forEach(d -> release(userId, d));
    }

    // ---------- files ----------

    /** A new or changed file's bytes. Returns the file's row as stored. */
    @Transactional
    public FolderFile syncFile(UUID userId, UUID folderId, String path, Instant modifiedTime, byte[] content) {
        Folder folder = requireFolder(userId, folderId);
        requireInside(folder, path);
        Optional<FolderFile> existing = folders.findFile(userId, path);
        UUID oldDoc = existing.map(FolderFile::documentId).orElse(null);
        Optional<Document> old = oldDoc == null ? Optional.empty() : documentRows.lockActive(userId, oldDoc);
        String sha = DocumentService.sha256(content);

        if (existing.isPresent() && old.isPresent() && sha.equals(existing.get().contentHash())) {
            return folders.touchFile(userId, existing.get().id(), modifiedTime, content.length);
        }

        String filename = DocumentService.cleanFilename(path);
        try {
            documents.checkSupported(content, filename);
        } catch (DocumentService.EmptyFileException | DocumentService.UnsupportedFileTypeException e) {
            FolderFile row = folders.upsertFile(userId, folderId, path, sha, modifiedTime, content.length,
                    FolderFile.FAILED, e.getMessage(), null);
            release(userId, oldDoc);
            return row;
        }

        Document doc;
        Optional<Document> sameContent = documentRows.findActiveBySha256(userId, sha);
        if (sameContent.isPresent()) {
            // Another file (or a hand upload) already has these bytes: share its document.
            doc = documentRows.lockActive(userId, sameContent.get().id()).orElseThrow();
        } else if (old.isPresent() && folders.countFilesForDocument(userId, oldDoc) == 1
                && documentRows.isFolderOrigin(userId, oldDoc)) {
            doc = documents.replace(userId, oldDoc, filename, content, JobQueue.BACKGROUND).document();
        } else {
            doc = documents.upload(userId, filename, content, DocumentRepository.ORIGIN_FOLDER, JobQueue.BACKGROUND)
                    .document();
        }
        FolderFile row = folders.upsertFile(userId, folderId, path, sha, modifiedTime, content.length,
                statusFor(doc), errorFor(doc), doc.id());
        if (oldDoc != null && !oldDoc.equals(doc.id())) {
            release(userId, oldDoc);
        }
        return row;
    }

    /** A file the desktop could not send (too large, unreadable). It counts as failed. */
    @Transactional
    public FolderFile recordFailure(UUID userId, UUID folderId, String path, Instant modifiedTime, long sizeBytes,
                                    String error) {
        Folder folder = requireFolder(userId, folderId);
        requireInside(folder, path);
        UUID oldDoc = folders.findFile(userId, path).map(FolderFile::documentId).orElse(null);
        if (oldDoc != null) {
            documentRows.lockActive(userId, oldDoc);
        }
        FolderFile row = folders.upsertFile(userId, folderId, path, null, modifiedTime, sizeBytes, FolderFile.FAILED,
                truncate(error), null);
        release(userId, oldDoc);
        return row;
    }

    /** Only the modified time or size changed; the desktop checked the hash is the same. */
    @Transactional
    public FolderFile touchFile(UUID userId, String path, Instant modifiedTime, long sizeBytes) {
        FolderFile file = folders.findFile(userId, path).orElseThrow(FileNotFoundException::new);
        return folders.touchFile(userId, file.id(), modifiedTime, sizeBytes);
    }

    /**
     * A rename or move (same content, new path). The index keeps the document and its chunks;
     * only the path and the document's display name change. A file already at the new path is
     * replaced, as the file system just did.
     */
    @Transactional
    public FolderFile moveFile(UUID userId, String fromPath, UUID toFolderId, String toPath) {
        FolderFile file = folders.findFile(userId, fromPath).orElseThrow(FileNotFoundException::new);
        Folder target = requireFolder(userId, toFolderId);
        requireInside(target, toPath);
        if (fromPath.equals(toPath)) {
            return file;
        }
        Optional<FolderFile> overwritten = folders.findFile(userId, toPath);
        List<UUID> locked = new ArrayList<>();
        if (file.documentId() != null) {
            locked.add(file.documentId());
        }
        overwritten.map(FolderFile::documentId).ifPresent(locked::add);
        locked.stream().distinct().forEach(d -> documentRows.lockActive(userId, d));

        overwritten.ifPresent(o -> folders.softDeleteFile(userId, o.id()));
        FolderFile moved = folders.moveFile(userId, file.id(), toFolderId, toPath);
        if (moved.documentId() != null && folders.countFilesForDocument(userId, moved.documentId()) == 1
                && documentRows.isFolderOrigin(userId, moved.documentId())) {
            documentRows.rename(userId, moved.documentId(), DocumentService.cleanFilename(toPath));
        }
        overwritten.map(FolderFile::documentId).ifPresent(d -> release(userId, d));
        return moved;
    }

    /** The file is gone from disk. Idempotent: deleting an unknown path does nothing. */
    @Transactional
    public void deleteFile(UUID userId, String path) {
        Optional<FolderFile> file = folders.findFile(userId, path);
        if (file.isEmpty()) {
            return;
        }
        UUID doc = file.get().documentId();
        if (doc != null) {
            documentRows.lockActive(userId, doc);
        }
        folders.softDeleteFile(userId, file.get().id());
        release(userId, doc);
    }

    /** Queues every needs-OCR file for indexing again (call after turning OCR on). Returns how many documents. */
    @Transactional
    public int retryNeedsOcr(UUID userId) {
        Set<UUID> docs = new LinkedHashSet<>();
        for (FolderSummary s : listFolders(userId)) {
            for (FolderFile f : folders.listFiles(userId, s.folder().id())) {
                if (FolderFile.NEEDS_OCR.equals(f.status()) && f.documentId() != null) {
                    docs.add(f.documentId());
                }
            }
        }
        int queued = 0;
        for (UUID id : docs) {
            Optional<Document> doc = documentRows.lockActive(userId, id);
            if (doc.isPresent() && Document.FAILED.equals(doc.get().status())) {
                documentRows.markQueued(userId, id, doc.get().version());
                jobs.enqueue(userId, id, doc.get().version(), JobQueue.BACKGROUND);
                folders.setStatusForDocument(userId, id, FolderFile.PENDING, null);
                queued++;
            }
        }
        return queued;
    }

    // ---------- helpers ----------

    /** Deletes a document folder sync created, once no watched file points at it any more. */
    private void release(UUID userId, UUID documentId) {
        if (documentId == null) {
            return;
        }
        if (folders.countFilesForDocument(userId, documentId) == 0 && documentRows.isFolderOrigin(userId, documentId)) {
            documents.delete(userId, documentId);
        }
    }

    static String statusFor(Document doc) {
        return switch (doc.status()) {
            case Document.INDEXED -> FolderFile.DONE;
            case Document.FAILED -> doc.error() != null && doc.error().contains(NeedsOcrException.MARKER)
                    ? FolderFile.NEEDS_OCR : FolderFile.FAILED;
            default -> FolderFile.PENDING;
        };
    }

    private static String errorFor(Document doc) {
        return Document.FAILED.equals(doc.status()) ? doc.error() : null;
    }

    private Folder requireFolder(UUID userId, UUID folderId) {
        return folders.findFolder(userId, folderId).orElseThrow(FolderNotFoundException::new);
    }

    private static void requireInside(Folder folder, String path) {
        if (path == null || path.length() > MAX_PATH_LENGTH || !isInside(folder.path(), path)) {
            throw new InvalidPathException("The file is not inside the folder " + folder.path());
        }
    }

    static String cleanFolderPath(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new InvalidPathException("Give the folder's full path");
        }
        String path = raw.strip();
        while (path.length() > 1 && (path.endsWith("\\") || path.endsWith("/")) && !path.matches("^[A-Za-z]:[\\\\/]$")) {
            path = path.substring(0, path.length() - 1);
        }
        if (!ABSOLUTE.matcher(path).matches() || path.length() > MAX_PATH_LENGTH) {
            throw new InvalidPathException("Give the folder's full path, for example C:\\Users\\you\\Documents");
        }
        return path;
    }

    /**
     * True if {@code path} is strictly inside {@code folder}. Compared case-insensitively with either
     * slash, because SMOI's desktop app runs on Windows, whose paths work that way.
     */
    static boolean isInside(String folder, String path) {
        String f = normalise(folder);
        String p = normalise(path);
        String prefix = f.endsWith("/") ? f : f + "/";
        return p.length() > prefix.length() && p.startsWith(prefix);
    }

    private static boolean samePath(String a, String b) {
        return normalise(a).equals(normalise(b));
    }

    private static String normalise(String path) {
        return path.replace('\\', '/').toLowerCase(Locale.ROOT);
    }

    private static String truncate(String error) {
        if (error == null) {
            return "Could not send the file";
        }
        return error.length() > 1000 ? error.substring(0, 1000) : error;
    }

    public static class FolderNotFoundException extends RuntimeException {
        public FolderNotFoundException() {
            super("Folder not found");
        }
    }

    public static class FileNotFoundException extends RuntimeException {
        public FileNotFoundException() {
            super("That file is not in any of your folders");
        }
    }

    public static class FolderOverlapException extends RuntimeException {
        public FolderOverlapException(String existing) {
            super("That folder is already covered by, or contains, a folder you added: " + existing);
        }
    }

    public static class InvalidPathException extends RuntimeException {
        public InvalidPathException(String message) {
            super(message);
        }
    }
}
