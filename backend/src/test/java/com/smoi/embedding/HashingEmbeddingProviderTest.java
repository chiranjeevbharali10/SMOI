package com.smoi.embedding;

import java.util.List;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class HashingEmbeddingProviderTest {

    private final HashingEmbeddingProvider provider = new HashingEmbeddingProvider();

    private static double cosine(float[] a, float[] b) {
        double dot = 0;
        for (int i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
        }
        return dot; // vectors are unit length
    }

    @Test
    void producesUnitVectorsOfTheSchemaSize() {
        float[] v = provider.embedQuery("frogs eat insects");
        double norm = 0;
        for (float x : v) {
            norm += x * x;
        }
        assertThat(v).hasSize(EmbeddingProvider.DIMENSIONS);
        assertThat(norm).isCloseTo(1.0, within(1e-5));
    }

    @Test
    void isDeterministic() {
        assertThat(provider.embedQuery("same text")).isEqualTo(provider.embedDocuments(List.of("same text")).getFirst());
    }

    @Test
    void textsSharingWordsAreCloserThanUnrelatedTexts() {
        float[] query = provider.embedQuery("green tree frogs");
        float[] related = provider.embedQuery("tree frogs are green and small");
        float[] unrelated = provider.embedQuery("quarterly tax filing deadline");

        assertThat(cosine(query, related)).isGreaterThan(cosine(query, unrelated));
    }

    @Test
    void textWithoutWordsStillGetsAUsableVector() {
        assertThat(provider.embedQuery("  ...  ")[0]).isEqualTo(1f);
    }
}
