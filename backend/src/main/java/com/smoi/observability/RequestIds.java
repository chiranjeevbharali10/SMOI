package com.smoi.observability;

import java.util.UUID;
import java.util.regex.Pattern;

import org.slf4j.MDC;

/**
 * The request id every log line carries (NFR-07.04), held in the logging MDC under
 * {@value #MDC_KEY}. The JSON log encoder writes MDC entries as fields, so all lines of one
 * request (and of the ingestion job it started) can be found with one search.
 */
public final class RequestIds {

    public static final String MDC_KEY = "requestId";
    public static final String HEADER = "X-Request-Id";

    /** Accept a caller's id only if it is short and plain, so it can't inject anything into logs. */
    private static final Pattern SAFE = Pattern.compile("[A-Za-z0-9._-]{1,64}");

    private RequestIds() {
    }

    /** The caller's id if it is safe to log, otherwise a fresh one. */
    public static String fromHeader(String header) {
        return header != null && SAFE.matcher(header).matches() ? header : UUID.randomUUID().toString();
    }

    public static String current() {
        return MDC.get(MDC_KEY);
    }

    /** Puts the id in the MDC until the returned scope is closed. A null id leaves the MDC unchanged. */
    public static Scope bind(String requestId) {
        if (requestId == null) {
            return () -> { };
        }
        String previous = MDC.get(MDC_KEY);
        MDC.put(MDC_KEY, requestId);
        return () -> {
            if (previous == null) {
                MDC.remove(MDC_KEY);
            } else {
                MDC.put(MDC_KEY, previous);
            }
        };
    }

    @FunctionalInterface
    public interface Scope extends AutoCloseable {
        @Override
        void close();
    }
}
