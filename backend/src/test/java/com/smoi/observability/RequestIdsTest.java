package com.smoi.observability;

import org.junit.jupiter.api.Test;
import org.slf4j.MDC;

import static org.assertj.core.api.Assertions.assertThat;

class RequestIdsTest {

    @Test
    void keepsPlainIdsAndReplacesAnythingElse() {
        assertThat(RequestIds.fromHeader("abc-123_x.y")).isEqualTo("abc-123_x.y");
        assertThat(RequestIds.fromHeader(null)).hasSize(36);
        assertThat(RequestIds.fromHeader("")).hasSize(36);
        assertThat(RequestIds.fromHeader("a b")).hasSize(36);
        assertThat(RequestIds.fromHeader("x".repeat(65))).hasSize(36);
        assertThat(RequestIds.fromHeader("{\"json\":1}")).hasSize(36);
    }

    @Test
    void bindRestoresThePreviousIdWhenClosed() {
        try (var outer = RequestIds.bind("outer")) {
            try (var inner = RequestIds.bind("inner")) {
                assertThat(RequestIds.current()).isEqualTo("inner");
            }
            assertThat(RequestIds.current()).isEqualTo("outer");
        }
        assertThat(MDC.get(RequestIds.MDC_KEY)).isNull();
    }

    @Test
    void bindingNullChangesNothing() {
        try (var ignored = RequestIds.bind(null)) {
            assertThat(RequestIds.current()).isNull();
        }
    }
}
