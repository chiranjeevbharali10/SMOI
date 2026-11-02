package com.smoi.ingestion;

/**
 * The worker no longer owns the job: its lease ran out and another worker claimed it, or the
 * job was cancelled. The worker must stop without writing anything.
 */
class LeaseLostException extends RuntimeException {

    LeaseLostException(IngestionJob job) {
        super("Lost the lease on ingestion job " + job.id());
    }
}
