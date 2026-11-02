package com.smoi.ingestion.chunking;

/**
 * A chunk produced by the {@link Chunker}, before it has an embedding.
 *
 * @param index      position in the document, starting at 0
 * @param text       the chunk's text; paragraphs are separated by a blank line
 * @param pageStart  first page the text comes from, or {@code null} if the format has no pages
 * @param pageEnd    last page the text comes from, or {@code null}
 * @param section    heading path, for example "Methods > Sampling", or {@code null}
 * @param tokenCount estimated tokens (see {@link TokenEstimator})
 */
public record ChunkDraft(int index, String text, Integer pageStart, Integer pageEnd, String section, int tokenCount) {
}
