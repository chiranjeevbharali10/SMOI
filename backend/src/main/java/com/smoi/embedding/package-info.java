/**
 * Embedding providers: turn text into vectors. {@link com.smoi.embedding.EmbeddingProvider}
 * is the only type other packages use; configuration picks the implementation (Ollama for
 * real use, a deterministic hashing embedder for tests).
 */
package com.smoi.embedding;
