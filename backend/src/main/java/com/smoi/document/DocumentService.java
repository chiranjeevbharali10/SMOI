package com.smoi.document;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import com.smoi.ingestion.JobQueue;
import com.smoi.ingestion.parsing.DocumentParser;
import org.apache.tika.Tika;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Upload, replace, delete and read documents. Writing a document and queuing its ingestion
 * job happen in one transaction, so a document never exists without a job to index it (and
 * a job never exists without its document).
 */
@Service
public class DocumentService {

    static final Set<String> SUPPORTED_TYPES = Set.of(DocumentParser.PDF, DocumentParser.DOCX, DocumentParser.TXT);
    private static final int MAX_FILENAME_LENGTH = 255;

    private final DocumentRepository documents;
    private final ChunkRepository chunks;
    private final JobQueue jobs;
    private final Tika tika = new Tika();

    public DocumentService(DocumentRepository documents, ChunkRepository chunks, JobQueue jobs) {
        this.documents = documents;
        this.chunks = chunks;
        this.jobs = jobs;
    }

    /** @param created false if the user already had this exact file; then nothing new was stored */
    public record UploadResult(Document document, boolean created) {
    }

    /**
     * Stores the file and queues it for indexing. Uploading content the user already has
     * (for example a client retrying after a timeout) returns the existing document instead
     * of creating a duplicate.
     */
    @Transactional
    public UploadResult upload(UUID userId, String originalFilename, byte[] content) {
        String mediaType = detectSupportedType(content, originalFilename);
        String sha256 = sha256(content);
        Optional<Document> inserted = documents.insertIfNew(userId, cleanFilename(originalFilename), mediaType, sha256, content);
        if (inserted.isPresent()) {
            jobs.enqueue(userId, inserted.get().id(), inserted.get().version());
            return new UploadResult(inserted.get(), true);
        }
        Document existing = documents.findActiveBySha256(userId, sha256)
                .orElseThrow(() -> new IllegalStateException("Duplicate detected but no active document found"));
        return new UploadResult(existing, false);
    }

    /**
     * Replaces a document's file and queues a re-index. The old chunks stay searchable until the
     * new ones are stored. Returns {@code changed = false} if the file is identical to the current one.
     */
    @Transactional
    public UploadResult replace(UUID userId, UUID documentId, String originalFilename, byte[] content) {
        String mediaType = detectSupportedType(content, originalFilename);
        String sha256 = sha256(content);
        Document current = documents.lockActive(userId, documentId).orElseThrow(DocumentNotFoundException::new);
        if (current.contentSha256().equals(sha256)) {
            return new UploadResult(current, false);
        }
        Document updated;
        try {
            updated = documents.replaceContent(userId, documentId, cleanFilename(originalFilename), mediaType, sha256, content);
        } catch (DuplicateKeyException e) {
            throw new DuplicateContentException();
        }
        jobs.cancelUnfinished(userId, documentId, "Superseded by version " + updated.version());
        jobs.enqueue(userId, documentId, updated.version());
        return new UploadResult(updated, true);
    }

    /** Deletes the document, its file bytes, and all its chunks and vectors. */
    @Transactional
    public void delete(UUID userId, UUID documentId) {
        // softDelete locks the document row first, the same lock order the ingestion worker uses.
        if (!documents.softDelete(userId, documentId)) {
            throw new DocumentNotFoundException();
        }
        jobs.cancelUnfinished(userId, documentId, "Document deleted");
        chunks.deleteForDocument(userId, documentId);
    }

    /**
     * Allows or forbids sending this document's text to a hosted LLM provider. Off by default.
     * With a local provider the setting has no effect.
     */
    public Document setHostedLlmAllowed(UUID userId, UUID documentId, boolean allowed) {
        return documents.setHostedLlmAllowed(userId, documentId, allowed).orElseThrow(DocumentNotFoundException::new);
    }

    public Document get(UUID userId, UUID documentId) {
        return documents.findActive(userId, documentId).orElseThrow(DocumentNotFoundException::new);
    }

    public List<Document> list(UUID userId) {
        return documents.listActive(userId);
    }

    public List<Chunk> chunks(UUID userId, UUID documentId) {
        get(userId, documentId); // 404 for a missing document, even if it once had chunks
        return chunks.listForDocument(userId, documentId);
    }

    /**
     * Decides the file type from its bytes (with the filename as a hint), not from the
     * extension or the Content-Type the client sent, which are easy to get wrong or fake.
     */
    private String detectSupportedType(byte[] content, String filename) {
        if (content.length == 0) {
            throw new EmptyFileException();
        }
        String detected = tika.detect(content, filename);
        if (!SUPPORTED_TYPES.contains(detected)) {
            throw new UnsupportedFileTypeException(detected);
        }
        return detected;
    }

    /** Keeps only the last path segment (browsers on Windows may send a full path). */
    static String cleanFilename(String original) {
        if (original == null) {
            return "untitled";
        }
        String name = original.substring(Math.max(original.lastIndexOf('/'), original.lastIndexOf('\\')) + 1).strip();
        if (name.isEmpty()) {
            return "untitled";
        }
        return name.length() > MAX_FILENAME_LENGTH ? name.substring(0, MAX_FILENAME_LENGTH) : name;
    }

    static String sha256(byte[] content) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is always available in the JDK", e);
        }
    }

    public static class DocumentNotFoundException extends RuntimeException {
        public DocumentNotFoundException() {
            super("Document not found");
        }
    }

    public static class EmptyFileException extends RuntimeException {
        public EmptyFileException() {
            super("The file is empty");
        }
    }

    public static class UnsupportedFileTypeException extends RuntimeException {
        public UnsupportedFileTypeException(String detected) {
            super("Unsupported file type " + detected + ". SMOI accepts PDF, DOCX and plain text.");
        }
    }

    public static class DuplicateContentException extends RuntimeException {
        public DuplicateContentException() {
            super("Another of your documents already has exactly this content");
        }
    }
}
