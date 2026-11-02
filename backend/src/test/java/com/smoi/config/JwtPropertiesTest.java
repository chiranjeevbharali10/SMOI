package com.smoi.config;

import java.time.Duration;
import java.util.Base64;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Fast unit tests (no Docker): startup refuses a missing or weak JWT secret. */
class JwtPropertiesTest {

    private static String keyOfLength(int bytes) {
        return Base64.getEncoder().encodeToString(new byte[bytes]);
    }

    @Test
    void acceptsA32ByteKey() {
        assertThatCode(() -> new JwtProperties(keyOfLength(32), "smoi", Duration.ofHours(1))).doesNotThrowAnyException();
    }

    @Test
    void rejectsMissingSecret() {
        assertThatThrownBy(() -> new JwtProperties("", "smoi", Duration.ofHours(1)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("must be set");
    }

    @Test
    void rejectsShortKey() {
        assertThatThrownBy(() -> new JwtProperties(keyOfLength(16), "smoi", Duration.ofHours(1)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("at least 32 bytes");
    }

    @Test
    void rejectsNonBase64Secret() {
        assertThatThrownBy(() -> new JwtProperties("not base64 !!!", "smoi", Duration.ofHours(1)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("Base64");
    }

    @Test
    void rejectsNonPositiveTtl() {
        assertThatThrownBy(() -> new JwtProperties(keyOfLength(32), "smoi", Duration.ZERO))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("ttl");
    }
}
