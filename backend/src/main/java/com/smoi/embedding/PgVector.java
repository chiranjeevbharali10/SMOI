package com.smoi.embedding;

/** Formats a vector in pgvector's text format, {@code [0.1,0.2,...]}, for {@code CAST(? AS vector)} in SQL. */
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
}
