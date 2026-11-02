package com.smoi.observability;

import java.util.function.Supplier;

import io.micrometer.tracing.Span;
import io.micrometer.tracing.Tracer;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/**
 * Child spans for the stages of a request or ingestion job (embed, keyword, vector, rerank,
 * generate; parse, chunk, embed, store), so a trace in Jaeger shows where the time went.
 *
 * <p>Spans carry only stage names and low-risk attributes (mode, counts). Never document text,
 * questions or answers: traces leave the process just like logs (NFR-07.04).
 */
@Component
public class Spans {

    private final Tracer tracer;

    public Spans(ObjectProvider<Tracer> tracer) {
        this.tracer = tracer.getIfAvailable(() -> Tracer.NOOP);
    }

    public <T> T in(String name, Supplier<T> work) {
        Span span = tracer.nextSpan().name(name).start();
        try (Tracer.SpanInScope ignored = tracer.withSpan(span)) {
            return work.get();
        } catch (RuntimeException e) {
            span.error(e);
            throw e;
        } finally {
            span.end();
        }
    }

    public void in(String name, Runnable work) {
        in(name, () -> {
            work.run();
            return null;
        });
    }

    /** Adds an attribute to the current span (for example the retrieval mode). */
    public void tag(String key, String value) {
        Span current = tracer.currentSpan();
        if (current != null) {
            current.tag(key, value);
        }
    }
}
