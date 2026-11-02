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

## Phase 2: retrieval and cited answers

| Requirement | Checked by |
| --- | --- |
| FR-06.05 keyword, vector and hybrid retrieval, selectable per request | `retrieval/SearchIT` (`everyModeReturnsRankedResults` for all four modes, `keywordSearchFindsARareExactTerm`, `keywordSearchMatchesAnyWordNotAllWords`, `hybridRecordsWhichListsEachResultCameFrom`); `retrieval/ReciprocalRankFusionTest` |
| Reranking with fallback | `SearchIT.rerankingReordersTheCandidates`, `whenTheRerankerIsDownResultsComeBackInHybridOrderAndSaySo`; `AnswerIT.answersStillComeBackWhenTheRerankerIsDown`; sidecar API tests in `sidecars/reranker/tests` |
| FR-06.06 answer only from sources; "don't know" | `AnswerIT.theModelSayingItDoesNotKnowIsADontKnowOutcome`, `withNothingRetrievedTheModelIsNotAskedAtAll` (scripted LLM) |
| FR-06.07 citations with document, location and chunk | `AnswerIT.answerCitesRetrievedChunksResolvedToTheirSource` |
| FR-06.08 typed questions (voice in Phase 7) | `AnswerIT`, including streaming: `streamingSendsSourcesThenTextThenTheResult` |
| FR-06.09 summarise and compare with citations | `answer/InsightIT` (single pass, multi-pass map-reduce, compare, fabricated citations, 404, hosted 403) |
| FR-06.12 / NFR-09.04 citations must name retrieved chunks | `AnswerIT.aCitationOfASourceThatWasNotRetrievedIsRejected`, `aCitationByRawIdIsRejected`, `anAnswerWithoutAnyCitationIsRejected`, `streamingAlsoReportsARejectedAnswerInTheResult`; `answer/CitationsTest` |
| NFR-03.08 instructions and data kept apart | `AnswerIT.sourcesArePassedAsEscapedDataSeparateFromInstructions`, `injectedMarkupInADocumentCannotBreakOutOfItsSourceElement`; `answer/PromptsTest` |
| NFR-03.11 / NFR-03.13 retrieval scoped to the user | `SearchIT.anotherUserNeverSeesTheseChunks` (all four modes), `deletedDocumentsAreNotRetrieved`; `AnswerIT.anotherUsersDocumentsNeverReachThePrompt` |
| NFR-04.05 local-only option; active providers shown | Ollama is the default provider; `AnswerIT.providersEndpointShowsWhatIsActive`; hosted consent: `AnswerIT.aHostedProviderOnlySeesDocumentsTheUserAllowed`, `aHostedProviderWithNoAllowedDocumentsIsNotCalled`, `SearchIT.hostedOnlyRetrievalSkipsDocumentsNotAllowedForHostedLlms`, `anotherUserCannotChangeTheHostedSetting` |
| Prompt never silently cut off | `AnswerIT.sourcesThatDoNotFitThePromptBudgetAreLeftOutAndReported`; `llm/OllamaLlmProviderTest.aPromptThatFilledTheContextIsAnErrorNotASilentTruncation` |
| Refusals are their own outcome and metric | `AnswerIT.aProviderRefusalIsReportedAndCountedAsItsOwnOutcome` |
| NFR-07.02 OpenAPI generated from code | `AnswerIT.openApiSpecIsGeneratedFromTheControllers` (`/v3/api-docs`) |
| Claude features used (Haiku 5.5) | `llm/AnthropicLiveIT`: runs only with `ANTHROPIC_API_KEY` set; **skipped so far** |
| NFR-01.05 retrieval latency | Not measured yet (Phase 4). Responses report per-stage timings. |

## Phase 3: evaluation

Every number is produced by `eval/run_eval.py` and written to `docs/benchmarks.md`, which names the
results file it came from. The method is in `docs/adr/0010-evaluation-method.md`.

| Requirement | Checked by |
| --- | --- |
| NFR-09.01 retrieval finds the relevant chunks | `run_eval.py run`: Recall@5 and @10 per mode, group and question type; CI regression check in `.github/workflows/eval.yml` against `eval/thresholds.json` |
| NFR-09.02 relevant chunks ranked near the top | `run_eval.py run`: MRR@10 and nDCG@10 per mode |
| NFR-09.03 citations support their claims | Deterministic: share of cited chunks containing labelled evidence. Estimate: LLM-judged faithfulness, with agreement against the owner's hand labels (`eval/labels/`) |
| NFR-09.04 citations name retrieved chunks | Enforced by the backend (Phase 2 tests); the harness counts rejections and re-checks every accepted citation |
| NFR-09.05 "don't know" when sources don't cover the question | Correct "don't know" rate on `not_answerable` questions and false "don't know" rate on answerable ones |
| NFR-09.06 intent classification | Not measurable yet: the intent classifier arrives in Phase 7 |
| NFR-09.08 latency reported with quality | p50 and p95 per retrieval mode and per answer stage |
| Scoring code is correct | `eval/tests/test_metrics.py` (quote matching, recall, MRR, nDCG, percentiles, kappa, sentence splitting, evidence parsing, judge parsing) |
| Labels match the corpus | `run_eval.py validate` (offline) and a check against the indexed chunks at the start of every run |
