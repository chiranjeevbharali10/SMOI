package com.smoi.ingestion.parsing;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class TextCleanerTest {

    @Test
    void joinsWordsHyphenatedAcrossLineBreaks() {
        assertThat(TextCleaner.cleanParagraph("retrieval-aug-\nmented infor-\r\n  mation")).isEqualTo("retrieval-augmented information");
    }

    @Test
    void keepsRealHyphensBeforeCapitals() {
        assertThat(TextCleaner.cleanParagraph("Spring-\nBoot")).isEqualTo("Spring- Boot");
    }

    @Test
    void turnsLayoutLineBreaksAndRunsOfSpacesIntoSingleSpaces() {
        assertThat(TextCleaner.cleanParagraph("  one\ntwo \t three\n\n")).isEqualTo("one two three");
    }

    @Test
    void normalisesLigaturesNonBreakingSpacesAndRemovesControlCharacters() {
        assertThat(TextCleaner.cleanParagraph("ﬁne print\u0007 co­operate")).isEqualTo("fine print cooperate");
    }

    @Test
    void whitespaceOnlyBecomesEmpty() {
        assertThat(TextCleaner.cleanParagraph(" \n\t ")).isEmpty();
    }
}
