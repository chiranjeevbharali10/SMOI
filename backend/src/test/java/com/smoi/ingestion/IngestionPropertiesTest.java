package com.smoi.ingestion;

import java.time.Duration;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class IngestionPropertiesTest {

    private final IngestionProperties props = new IngestionProperties(
            2, Duration.ofSeconds(1), Duration.ofMinutes(2), 5, Duration.ofSeconds(10), Duration.ofMinutes(10));

    @Test
    void backoffDoublesAfterEachFailedAttempt() {
        assertThat(props.backoffAfter(1)).isEqualTo(Duration.ofSeconds(10));
        assertThat(props.backoffAfter(2)).isEqualTo(Duration.ofSeconds(20));
        assertThat(props.backoffAfter(3)).isEqualTo(Duration.ofSeconds(40));
        assertThat(props.backoffAfter(4)).isEqualTo(Duration.ofSeconds(80));
    }

    @Test
    void backoffIsCapped() {
        assertThat(props.backoffAfter(7)).isEqualTo(Duration.ofMinutes(10)); // 640 s would exceed the cap
        assertThat(props.backoffAfter(1000)).isEqualTo(Duration.ofMinutes(10));
    }
}
