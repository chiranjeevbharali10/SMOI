/**
 * Ingestion: turns uploaded files into indexed chunks in the background. A Postgres-backed
 * job queue ({@link com.smoi.ingestion.JobQueue}), worker threads that claim jobs, and the
 * pipeline that parses ({@code parsing}), chunks ({@code chunking}), embeds and stores them.
 * Handles retries with backoff, the dead-letter state, and recovery from crashed workers.
 */
package com.smoi.ingestion;
