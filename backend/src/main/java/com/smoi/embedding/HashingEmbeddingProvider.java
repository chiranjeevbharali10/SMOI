package com.smoi.embedding;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import java.util.zip.CRC32;

/**
 * A deterministic embedder with no model and no network, used by tests and CI.
 *
 * <p>It uses the "hashing trick": each word is hashed to one of 768 positions and adds +1 or
 * -1 there, then the vector is scaled to length 1. Texts that share words get similar
 * vectors, so it behaves like keyword overlap. It knows nothing about meaning ("car" and
 * "vehicle" are unrelated), so it is not a substitute for a real model in use.
 */
public class HashingEmbeddingProvider implements EmbeddingProvider {

    private static final Pattern NON_WORD = Pattern.compile("[^\\p{L}\\p{N}]+");

    @Override
    public String modelId() {
        return "hashing-v1";
    }

    @Override
    public List<float[]> embedDocuments(List<String> texts) {
        List<float[]> vectors = new ArrayList<>(texts.size());
        for (String text : texts) {
            vectors.add(embed(text));
        }
        return vectors;
    }

    @Override
    public float[] embedQuery(String text) {
        return embed(text);
    }

    static float[] embed(String text) {
        float[] vector = new float[DIMENSIONS];
        for (String word : NON_WORD.split(text.toLowerCase(Locale.ROOT))) {
            if (word.isEmpty()) {
                continue;
            }
            CRC32 crc = new CRC32();
            crc.update(word.getBytes(StandardCharsets.UTF_8));
            long hash = crc.getValue();
            int position = (int) (hash % DIMENSIONS);
            // A second bit of the hash picks the sign, so unrelated words cancel out on average
            // instead of piling up in the same direction.
            vector[position] += ((hash >>> 16) & 1) == 0 ? 1f : -1f;
        }
        double norm = 0;
        for (float v : vector) {
            norm += v * v;
        }
        if (norm == 0) {
            // No words at all. pgvector can store a zero vector, but cosine distance to it is
            // undefined, so give it a fixed direction instead.
            vector[0] = 1f;
            return vector;
        }
        float scale = (float) (1 / Math.sqrt(norm));
        for (int i = 0; i < vector.length; i++) {
            vector[i] *= scale;
        }
        return vector;
    }
}
