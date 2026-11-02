package com.smoi.ingestion;

import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * Background worker threads. Each one loops: claim a job, run it, repeat; sleep briefly when
 * the queue is empty. Upload requests never wait for this: they only insert a job row.
 *
 * <p>Workers share nothing in memory. All coordination goes through the job table, so the
 * same code works with several threads, or with several backend processes on one database.
 */
@Component
public class IngestionWorkerPool implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(IngestionWorkerPool.class);

    private final JobQueue queue;
    private final IngestionPipeline pipeline;
    private final IngestionProperties props;
    private volatile boolean running;
    private ExecutorService executor;

    public IngestionWorkerPool(JobQueue queue, IngestionPipeline pipeline, IngestionProperties props) {
        this.queue = queue;
        this.pipeline = pipeline;
        this.props = props;
    }

    @Override
    public void start() {
        running = true;
        if (props.workers() == 0) {
            log.info("Ingestion workers disabled (smoi.ingestion.workers=0)");
            return;
        }
        AtomicInteger counter = new AtomicInteger();
        executor = Executors.newFixedThreadPool(props.workers(),
                r -> new Thread(r, "ingestion-worker-" + counter.incrementAndGet()));
        for (int i = 0; i < props.workers(); i++) {
            executor.submit(this::workLoop);
        }
        log.info("Started {} ingestion workers", props.workers());
    }

    private void workLoop() {
        while (running) {
            try {
                Optional<IngestionJob> job = queue.claim();
                if (job.isPresent()) {
                    pipeline.run(job.get());
                } else {
                    Thread.sleep(props.pollInterval());
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception e) {
                // For example the database is briefly unreachable. Keep the worker alive; any job
                // it had claimed is recovered when its lease expires.
                log.error("Ingestion worker loop error", e);
                try {
                    Thread.sleep(props.pollInterval());
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    @Override
    public void stop() {
        running = false;
        if (executor != null) {
            executor.shutdownNow();
            try {
                if (!executor.awaitTermination(10, TimeUnit.SECONDS)) {
                    log.warn("Ingestion workers did not stop in time; their jobs will be retried after the lease expires");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    @Override
    public boolean isRunning() {
        return running;
    }
}
