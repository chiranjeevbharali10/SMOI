# Requirement traceability

Which automated tests check which requirements in [srs.md](srs.md). Updated as phases are built.
Test paths are relative to `backend/src/test/java/com/smoi/`. Run them all with `cd backend && ./mvnw verify`.

## Phase 0

| Requirement | Checked by |
| --- | --- |
| NFR-03.02 BCrypt, HS256 JWT ≤ 1 h, same response for unknown email and wrong password | `auth/AuthIT`, `config/JwtPropertiesTest` |
| NFR-07.03 tests in CI | `.github/workflows/backend.yml` runs `./mvnw verify` |

## Phase 1: document ingestion

| Requirement | Checked by |
| --- | --- |
| FR-06.01 upload PDF/DOCX/TXT, returns at once with id and status | `document/DocumentIngestionIT`: `uploadReturnsImmediatelyWithIdAndQueuedStatus`, the per-format tests, `unsupportedFileTypeIsRejectedByContentNotByName`, `emptyFileIsRejected`, `fileOverTheSizeLimitIsRejected` |
| FR-06.03 extract, clean, chunk; source location per chunk | `DocumentIngestionIT.multiPagePdfIsIndexedWithCorrectPageNumbers`, `docxChunksRecordTheirHeadingPath`, `plainTextIsSplitIntoParagraphChunks`; `ingestion/parsing/DocumentParserTest`, `TextCleanerTest`; `ingestion/chunking/ChunkerTest` |
| FR-06.04 embedding per chunk, provider chosen by configuration | Every indexed-document test checks `embeddingModel`; `embedding/OllamaEmbeddingProviderTest` (against a fake Ollama server), `HashingEmbeddingProviderTest` |
| FR-06.10 delete removes chunks and vectors | `DocumentIngestionIT.deletingADocumentRemovesItsChunksAndHidesIt`, `IngestionReliabilityIT.deletingADocumentWhileItIsBeingIndexedLeavesNoChunks` |
| NFR-02.03 retried create makes no duplicate | `DocumentIngestionIT.uploadingTheSameFileAgainReturnsTheExistingDocumentAndCreatesNoChunks`, `IngestionReliabilityIT.retryingTheSameUploadConcurrentlyCreatesOneDocument` |
| NFR-02.04 crashed worker's job is completed later | `IngestionReliabilityIT.jobFromAWorkerThatDiedMidJobIsCompletedByAnotherWorker` (see note) |
| NFR-02.06 retry with backoff, then dead-letter with reason | `IngestionReliabilityIT.temporaryEmbeddingFailuresAreRetriedUntilTheySucceed`, `persistentFailureEndsInTheDeadLetterStateWithTheReason`, `corruptFileGoesStraightToDeadLetterWithoutRetrying`; `ingestion/IngestionPropertiesTest` (backoff schedule) |
| NFR-03.04 / NFR-03.12 user B can't read, change or delete user A's documents | `document/DocumentIsolationIT` (get, chunks, list, replace, delete, duplicate detection per user) |
| NFR-03.13 user_id on every user-owned table and query | Schema: `V3`–`V5` migrations. Queries: code review; the one exception is documented in ADR 0005 |
| NFR-06.02 concurrent workers, no job processed twice | `IngestionReliabilityIT.manyConcurrentUploadsAreEachProcessedExactlyOnce` (20 uploads, 4 workers, each job claimed once) |
| Atomic re-index | `DocumentIngestionIT.replacingTheFileSwapsTheChunksAndKeepsTheId` |

**Note on NFR-02.04.** The test can't kill the JVM it runs in. A worker thread instead claims the job
and then blocks, which leaves the database in exactly the state a killed process leaves: a `running` job
whose lease isn't renewed. The test checks that another worker completes the job after the lease expires,
and that the stuck worker, when it resumes, writes nothing. A test that kills and restarts a real
backend process is not yet automated.
