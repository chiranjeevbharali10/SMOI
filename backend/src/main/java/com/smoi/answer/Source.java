package com.smoi.answer;

import java.util.UUID;

import com.smoi.document.Chunk;
import com.smoi.retrieval.RetrievedChunk;

/**
 * A chunk as shown to the model, with the short label it cites it by ({@code S1}, {@code S2}, ...).
 * Labels map back to chunk ids on our side; the model never sees or produces ids.
 */
public record Source(String label, UUID chunkId, UUID documentId, String filename, int chunkIndex,
                     Integer pageStart, Integer pageEnd, String section, String content) {

    static Source of(String label, RetrievedChunk c) {
        return new Source(label, c.chunkId(), c.documentId(), c.filename(), c.chunkIndex(), c.pageStart(),
                c.pageEnd(), c.section(), c.content());
    }

    static Source of(String label, Chunk c, String filename) {
        return new Source(label, c.id(), c.documentId(), filename, c.chunkIndex(), c.pageStart(), c.pageEnd(),
                c.section(), c.content());
    }

    /** "p. 3", "pp. 3-4", a section path, or null. */
    String location() {
        if (pageStart != null) {
            return pageStart.equals(pageEnd) || pageEnd == null ? "p. " + pageStart : "pp. " + pageStart + "-" + pageEnd;
        }
        return section;
    }
}
