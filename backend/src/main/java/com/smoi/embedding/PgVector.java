package com.smoi.embedding;

/** Converts vectors to and from pgvector's text format, {@code [0.1,0.2,...]}. */
public final class PgVector {

    private PgVector() {
    }

    public static String literal(float[] vector) {
        StringBuilder sb = new StringBuilder(vector.length * 10).append('[');
        for (int i = 0; i < vector.length; i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(vector[i]);
        }
        return sb.append(']').toString();
    }

    /** Parses pgvector's text output ({@code embedding::text}). */
    public static float[] parse(String text) {
        String body = text.strip();
        body = body.substring(1, body.length() - 1);
        String[] parts = body.split(",");
        float[] vector = new float[parts.length];
        for (int i = 0; i < parts.length; i++) {
            vector[i] = Float.parseFloat(parts[i]);
        }
        return vector;
    }
}
