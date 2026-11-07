package com.smoi.answer;

import java.util.Set;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CitationsTest {

    private static final Set<String> GIVEN = Set.of("S1", "S2", "S3");

    @Test
    void collectsValidLabelsInOrderWithoutDuplicates() {
        Citations.Check check = Citations.check("A [S2]. B [S1][S2]. C [S3, S1].", GIVEN);

        assertThat(check.valid()).isTrue();
        assertThat(check.cited()).containsExactly("S2", "S1", "S3");
    }

    @Test
    void flagsLabelsThatWereNotGiven() {
        Citations.Check check = Citations.check("A [S1]. B [S4]. C [S1, S12].", GIVEN);

        assertThat(check.invalid()).containsExactly("S4", "S12");
    }

    @Test
    void flagsRawIdsAndOtherCitationStyles() {
        Citations.Check check = Citations.check(
                "A [3f2504e0-4f89-11d3-9a0c-0305e82c3301]. B [source 2]. C [Doc 1].", GIVEN);

        assertThat(check.invalid()).hasSize(3);
    }

    @Test
    void ignoresOrdinaryBrackets() {
        Citations.Check check = Citations.check("He said it [sic] twice [S1]. Array a[0] too.", GIVEN);

        assertThat(check.valid()).isTrue();
        assertThat(check.cited()).containsExactly("S1");
    }

    @Test
    void recognisesTheDontKnowSentence() {
        assertThat(Citations.isDontKnow("I don't know based on your documents.")).isTrue();
        assertThat(Citations.isDontKnow("  I don’t know based on your documents")).isTrue();
        assertThat(Citations.isDontKnow("The garden opens at nine [S1].")).isFalse();
        // A real qwen3.5:2b reply from the end-to-end check: a cited preamble, then the sentence.
        assertThat(Citations.isDontKnow("Based on your documents, there is no information about who invented "
                + "the bicycle [S1][S2][S3]. I don't know based on your documents.")).isTrue();
    }

    @Test
    void keepsAPartialAnswerButNotANegativePreamble() {
        String partial = "Your documents cover frogs [S1] and databases [S2]. I don't know based on your documents.";
        String rest = Citations.withoutDontKnow(partial);
        assertThat(rest).isEqualTo("Your documents cover frogs [S1] and databases [S2].");
        assertThat(Citations.hasCitedClaim(rest, GIVEN)).isTrue();

        String negative = Citations.withoutDontKnow("Based on your documents, there is no information about who "
                + "invented the bicycle [S1][S2]. I don't know based on your documents.");
        assertThat(Citations.hasCitedClaim(negative, GIVEN)).isFalse();
        assertThat(Citations.hasCitedClaim("The sources do not mention it [S1].", GIVEN)).isFalse();
        assertThat(Citations.hasCitedClaim("Frogs eat insects.", GIVEN)).isFalse();
    }
}
