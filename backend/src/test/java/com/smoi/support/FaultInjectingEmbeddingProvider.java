package com.smoi.support;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import com.smoi.embedding.EmbeddingException;
import com.smoi.embedding.EmbeddingProvider;
import com.smoi.embedding.HashingEmbeddingProvider;

/**
 * Test embedding provider: the real hashing embedder, plus faults that a test can switch on
 * for documents containing a marker string. Using a marker keeps a fault from affecting
 * documents uploaded by other tests in the same run.
 */
public class FaultInjectingEmbeddingProvider implements EmbeddingProvider {

    private final HashingEmbeddingProvider delegate = new HashingEmbeddingProvider();
    private final Map<String, AtomicInteger> failuresLeft = new ConcurrentHashMap<>();
    private final Map<String, Hang> hangs = new ConcurrentHashMap<>();
    private volatile boolean failQueries;

    /** The next {@code times} embedding calls for texts containing {@code marker} throw. */
    public void failNextCalls(String marker, int times) {
        failuresLeft.put(marker, new AtomicInteger(times));
    }

    /**
     * The first embedding call for texts containing {@code marker} blocks until released,
     * like a worker that hung or died mid-job: it holds the job but makes no progress and
     * stops renewing its lease.
     */
    public Hang hangOnce(String marker) {
        Hang hang = new Hang();
        hangs.put(marker, hang);
        return hang;
    }

    /** While true, every query embedding throws, like an embedding provider that is down. */
    public void failQueries(boolean fail) {
        failQueries = fail;
    }

    public void reset() {
        failQueries = false;
        failuresLeft.clear();
        hangs.values().forEach(Hang::release);
        hangs.clear();
    }

    @Override
    public String modelId() {
        return delegate.modelId();
    }

    @Override
    public List<float[]> embedDocuments(List<String> texts) {
        failuresLeft.forEach((marker, left) -> {
            if (mentions(texts, marker) && left.getAndUpdate(n -> Math.max(0, n - 1)) > 0) {
                throw new EmbeddingException("Injected embedding failure for " + marker);
            }
        });
        hangs.forEach((marker, hang) -> {
            if (mentions(texts, marker) && hang.triggered.compareAndSet(false, true)) {
                hang.block();
            }
        });
        return delegate.embedDocuments(texts);
    }

    @Override
    public float[] embedQuery(String text) {
        if (failQueries) {
            throw new EmbeddingException("Injected query embedding failure");
        }
        return delegate.embedQuery(text);
    }

    private static boolean mentions(List<String> texts, String marker) {
        return texts.stream().anyMatch(t -> t.contains(marker));
    }

    public static final class Hang {

        private final AtomicBoolean triggered = new AtomicBoolean();
        private final CountDownLatch hung = new CountDownLatch(1);
        private final CountDownLatch released = new CountDownLatch(1);
        private final CountDownLatch resumed = new CountDownLatch(1);

        private void block() {
            hung.countDown();
            try {
                released.await(60, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                resumed.countDown();
            }
        }

        /** Waits until a worker is stuck inside the embedding call. */
        public void awaitHung() throws InterruptedException {
            if (!hung.await(30, TimeUnit.SECONDS)) {
                throw new AssertionError("No worker reached the hanging embedding call");
            }
        }

        /** Lets the stuck worker continue, as if it came back to life. */
        public void release() {
            released.countDown();
        }

        public void awaitResumed() throws InterruptedException {
            if (!resumed.await(30, TimeUnit.SECONDS)) {
                throw new AssertionError("The hung worker did not resume");
            }
        }
    }
}
