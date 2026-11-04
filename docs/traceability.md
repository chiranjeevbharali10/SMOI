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

## Phase 4: observability and resilience

Measured results are in `docs/performance.md`, produced by `loadtest/run.py`. Decisions are in
`docs/adr/0011-observability-and-resilience.md`.

| Requirement | Checked by |
| --- | --- |
| NFR-01.05 retrieval p95 under 5 s | `loadtest/run.py search` and `scale` (results in `loadtest/results/`) |
| NFR-02.04 no jobs lost when a worker is killed | `loadtest/run.py worker-kill` (SIGKILL of the worker process during upload load); `IngestionReliabilityIT` (Phase 1) |
| NFR-02.07 provider down: fallback within a timeout | `resilience/ResilienceIT` (LLM down gives passages, breaker opens and stops calling, closes on recovery; embedding down gives keyword fallback); `loadtest/run.py llm-down` against the real stack |
| NFR-06.01 no per-user state in memory | Rate limits (`RateLimitIT`, including concurrent requests) and the query cache (`QueryEmbeddingCacheIT`) live in Postgres |
| NFR-06.03 latency at increasing corpus sizes | `loadtest/run.py scale` (1k, 10k, 100k chunks) |
| NFR-06.04 API and workers as separate processes | `INGESTION_WORKERS=0` vs workers; Compose `split` profile, used by `loadtest/run.py worker-kill` |
| NFR-07.04 JSON logs with request id, no content or secrets | `observability/ObservabilityIT` (sentinel text, password and token absent; job lines carry the upload's id), `RequestIdsTest` |
| Metrics, traces, dashboards | `ObservabilityIT.prometheusExposesSmoiMetrics`; dashboards and Jaeger checked live with the Compose stack |
| Per-user rate limiting | `ratelimit/RateLimitIT` (burst, Retry-After, per-user buckets, concurrency, unlimited endpoints) |
| LLM token and cost metrics | `llm/LlmMetricsTest` |

## Phase 6B: speech bubbles, menu panel and dashboard

Desktop tests are in `desktop/test/` and run with `cd desktop && npm test`. The real-desktop check
(`desktop/scripts/desktop-check.ts`) drives the built app with real mouse and keyboard input;
its latest results are in `docs/design/phase6b-comparison.md`. Decisions are in
`docs/adr/0013-desktop-ui-windows-and-api.md`.

| Requirement | Checked by |
| --- | --- |
| FR-01.04 clicking the frog opens the panel; the panel opens the dashboard | `panelActions.test.ts` (each row's state, line, mood and destination); `components.test.tsx` (rows, Enter, Esc); desktop check: "Clicking the frog opens the panel", "Talk to SMOI opens the chat" |
| FR-01.06 personality and appearance settings | Settings screen (reduced motion, walking, start on login, sleep delay); personality sliders are FR-08.02, Phase 7 |
| FR-06.07 / FR-06.12 in the UI: only verified citations are shown | `answer.test.ts` (sources event never shown as citations; a broken stream keeps its text, marked incomplete, with no citations; rejected citations drop the text) |
| FR-08.05 notifications as speech bubbles in the design's style | `bubbles.test.ts` (fade and dismissal rules); `components.test.tsx` (only pink has x); `layout.test.ts` (on screen, tail on the frog, never over the panel) |
| NFR-01.02 dashboard accepts input within 2 s | `desktop/scripts/measure-dashboard-open.ts`, results in `desktop/perf-results/`, summarised in `docs/performance.md` |
| NFR-02.07 in the UI: LLM fallback is clear | `answer.test.ts` (fallback shows passages and says why); `components.test.tsx` (passages are plain text) |
| NFR-03 renderer hardening: plain text, no navigation or new windows | `components.test.tsx` (HTML, Markdown image, link and script in an answer, a passage and a chunk render as text; no `img`, `a` or `script` elements) |
| JWT stored only with safeStorage | `session.test.ts` (encrypted on disk, memory only without encryption, expired or rejected tokens removed) |
| API client errors are plain and accurate | `api.test.ts` against a real local HTTP server (401, 404, 409, 413, 415, 429 with Retry-After, 500 with request id, backend down, SSE split mid-line, dropped stream) |
| NFR-05.01 ask SMOI Brain within 2 interactions | Desktop check: click the frog, Enter on "Talk to SMOI", and the question box has focus |
| NFR-05.03 WCAG AA contrast | `contrast.test.ts` (every text and non-text pair, read from `tokens.css`) |
| NFR-05.04 keyboard use, visible focus | `components.test.tsx` (arrow keys, Home/End, Esc, unavailable rows stay focusable); desktop check (real arrow and Esc keys, focus returns to the previous app) |
| NFR-05.06 reduced motion | Settings and tray toggle; bubbles and panel skip `smoi-pop` and `smoi-rise` (`tokens.css`) |
| NFR-08.03 / NFR-08.04 monitors and crisp scaling | Desktop check: frog crisp and unmoved with the bubble and panel open, at forced 100/125/150% and at each connected display's real scaling |
| Frog state priority: error, thinking/speaking, working, idle | `stateMachine.test.ts` ("Phase 6B state priority") |

## Phase 7: tasks, reminders and voice

Backend tests run with `cd backend && ./mvnw verify`; desktop tests with `cd desktop && npm test`;
sidecar API tests with `cd sidecars/whisper && python -m pytest`. Decisions are in
`docs/adr/0014-tasks-reminders-and-offline-sync.md` and `docs/adr/0015-voice-commands-and-intents.md`.

| Requirement | Checked by |
| --- | --- |
| FR-02.01 / FR-02.02 create, edit, delete, complete; priority, category, due date, description | `TaskIT` (all fields, edit, complete, delete, validation); Tasks screen |
| FR-02.03 one-time and recurring reminders | `TaskIT` (weekday reminders, validation); `recurrence.test.ts` (daily, weekly, monthly with short months, weekdays, daylight saving, other zones) |
| FR-02.04 reminder notification within 60 s | Scheduler every 15 s (`src/main/tasks.ts`); `taskService.test.ts` (fires once; a missed one fires once, marked missed) |
| FR-02.06 completion time kept; overdue list | `TaskIT` ("completingATaskKeepsTheCompletionTime", "listsOverdueTasksOnly"); `taskStore.test.ts` (overdue view) |
| FR-03.01 global shortcut, changeable, refusal reported | `src/main/voice.ts` (`apply`); Settings screen; manual check list below |
| FR-03.02 / NFR-04.02 / NFR-04.03 listening state while the mic is on, mic only after the shortcut | `src/main/voice.ts` (permission only for the recorder's own session while starting); `panelActions.test.ts` (listening line only with voice on); manual check |
| FR-03.03 speech-to-text behind a configured interface | `VoiceIT` (fake sidecar on a real port: text, service down, undecodable, too long, sign-in); `sidecars/whisper/tests` |
| FR-03.04 intents from a documented list, or unknown | `CommandParserTest` (allowlist, wrong types, non-JSON, time zones, past reminders); `CommandIT` |
| FR-03.05 routing | `commands.ts`: tasks and reminders to the local store; questions to SMOI Brain; calendar and email "not available yet" (`proposal.test.ts`) |
| FR-03.06 show before acting, confirm consequential actions | `CommandIT` ("proposesATaskWithoutCreatingIt"); `components.test.tsx` (confirm view, heard text stays plain text); `proposal.test.ts` |
| FR-03.07 Esc or the shortcut again cancels, mic released | `src/renderer/recorder-main.ts` (tracks stopped on cancel); manual check |
| FR-08.01 / FR-08.02 personality presets and 0 to 4 sliders | `personality.test.ts`; Settings screen |
| FR-08.03 lines reflect the event and settings, facts unchanged | `personality.test.ts` (every style keeps titles, counts and times; no overdue line at strictness 0 or with none overdue) |
| FR-08.04 / FR-08.06 categories, priorities, quiet hours, cooldown | `notify.test.ts` |
| FR-08.05 bubbles or native notifications | `src/main/notifier.ts`; Settings screen |
| NFR-02.01 / NFR-02.05 / NFR-08.05 works offline, nothing lost | `taskService.test.ts` (changes saved with the backend down and sent when it returns; kept across a restart; reminders fire with no backend); `taskStore.test.ts` (merge and outbox rules); `TaskIT` (newest edit wins, deletes win, capped clock) |
| NFR-03.04 isolation | `TaskIT` (Bob can't see, edit, delete or attach reminders to Alice's tasks) |
| NFR-01.03, NFR-01.04, NFR-09.06 | Not measured in this phase (owner's choice); targets stay TBD |

## Phase 8: Google Calendar and Gmail

Decisions in `docs/adr/0017-google-oauth-and-token-storage.md` and
`docs/adr/0018-gmail-sync-and-confirmed-google-changes.md`. Google is replaced in tests by
`backend/src/test/java/com/smoi/support/FakeGoogleServer.java`; all mail in tests and the eval set is synthetic.

| Requirement | Evidence |
| --- | --- |
| FR-04.01 / FR-05.01 OAuth code flow with PKCE, three scopes | `GoogleConnectionIT` (connects through the fake; S256 challenge; only the three scopes; state works once and only for its user) |
| NFR-03.03 tokens encrypted, never logged | `GoogleUnitTest` (AES-GCM: fresh IV, bound to the user, tamper and wrong-key rejected); `GoogleConnectionIT` (stored bytes don't contain the token; disconnect overwrites them); `GoogleHttp` logs method, path and status only |
| Token refresh | `GoogleConnectionIT.refreshesAnExpiredAccessTokenAndCarriesOn` |
| FR-05.12 invalid_grant pauses Google only, keeps data, reconnect works | `GoogleConnectionIT.invalidGrantMarksTheAccountForReconnectionAndKeepsLocalData`; desktop reconnect banner (`GoogleParts.tsx`) |
| NFR-04.04 disconnect revokes and can delete email data | `GoogleConnectionIT.disconnectRevokesTheTokenAndCanDeleteEmailData`, `disconnectWithoutDeletingKeepsEmails` |
| FR-04.02 upcoming events; busy flag | `CalendarIT.listsUpcomingEvents`; `GoogleUnitTest` (busy rule: 6 h, 3 back to back, overlaps counted once) |
| FR-04.03 / FR-04.04 create, change, delete, only after confirming | `CalendarIT` (proposals change nothing; before/after shown; confirm applies); `CalendarAndDraftIntentTest` (typed or spoken commands); `googleDesktop.test.ts` |
| FR-04.05 conflicts listed before confirming | `CalendarIT.aProposalChangesNothingAndListsConflicts`; `proposal.test.ts` |
| FR-04.06 event reminders | `CalendarIT.confirmingTwiceCreatesOneEvent` (popup reminder sent) |
| NFR-02.03 no duplicates on retry | `CalendarIT` (double confirm, lost response then retry, six concurrent confirms: one event); `GmailIT.aDraftRetriedAfterALostResponseIsNotDuplicated`, `aDraftIsCreatedOnlyAfterConfirmingAndOnlyOnce` |
| FR-05.02 bounded first sync, history after, expiry fallback | `GmailIT` (query and limit checked; history used; expired historyId gives a full sync without duplicates; only unread primary mail) |
| Reading never changes read state; rate-limit backoff | `GmailIT.readingNeverChangesMailAndNothingIsSentOrDeleted`, `rateLimitedSyncBacksOffAndRecovers`; `CalendarIT` (backs off, then gives up with a clear error) |
| FR-05.03 / FR-05.05 classify and summarise (80 words) | `EmailUnitTest`; `GmailIT.aSummaryIsCappedAndExtraFieldsAreIgnored` |
| FR-05.04 important mail alerts once, with no content | `GmailIT.anImportantEmailIsAnnouncedOnceEvenAcrossPollsAndRestarts`, `theFirstSyncsBacklogDoesNotSetOffAlerts`; `personality.ts` (`important_email` line has no email text); `panelActions.test.ts` |
| FR-02.05 / FR-05.06 / FR-05.07 email to task with a link back; open in Gmail | `GmailIT.anEmailBecomesATaskThatLinksBackOnce`; `googleDesktop.test.ts` (only Google's sites are opened) |
| FR-05.08 / FR-05.09 drafts only after confirming; only SMOI's own drafts updated | `GmailIT` (draft flow; header injection rejected; unknown draft refused); `EmailUnitTest` |
| FR-05.10 / FR-05.11 reminder linked to a draft, cancelled when the draft is gone | `GmailIT.aReminderForADraftIsCancelledOnceTheDraftIsGone`, `aReminderStillFiresWhenGoogleCannotBeAsked`, `aReminderCannotLinkAnotherUsersDraft`; `googleDesktop.test.ts` |
| FR-05.13 no send, delete or trash; all Gmail calls through one wrapper | `GmailSafetyTest` (reflection and source scan); `GoogleApiTest.forbiddenGmailCalls` checked in `GmailIT` |
| NFR-03.08 email is untrusted; injected instructions can't act | `GmailIT.anEmailWithInjectedInstructionsCannotChangeEventsOrDrafts` (a model that "obeys" still changes nothing); `CalendarAndDraftIntentTest.draftsOnlyToAnAddressTheUserSaid` |
| FR-06.02 index chosen emails into SMOI Brain, off by default | `GoogleConnectionIT.disconnectRevokesTheTokenAndCanDeleteEmailData` (index, then deleted with email data). Attachments are not indexed yet. |
| NFR-09.07 email classification quality | `python eval/run_eval.py email` (in `make eval`) on `eval/data/emails_v1.jsonl`; results in `docs/email-classification.md`. Target TBD. |
| End-to-end with a real Google account | Owner's manual checklist (pending) |

## Phase 10: Claude Code notifications

Decisions in `docs/adr/0016-claude-code-hooks.md`; setup in `docs/claude-code-hooks.md`.

| Requirement | Evidence |
| --- | --- |
| FR-10.01 / NFR-03.16 listener on 127.0.0.1, shared secret, validated payloads, nothing logged | `claudeHooks.test.ts` (real socket: bound address, missing and wrong secret, malformed JSON, bad `session_id`, wrong hook for the route, oversized body, unknown route, wrong method, foreign Host, rejection reasons never contain body text) |
| FR-10.02 runs by `session_id`, duration start to done, parallel sessions | `claudeRuns.test.ts` |
| FR-10.03 celebrate only at or above the threshold; no celebration without a start | `claudeRuns.test.ts` (below, at and above the threshold; done with no start; duplicate done) |
| FR-10.04 waiting always alerts, with its own pose | `claudeRuns.test.ts`; `personality.ts` (`claude_waiting` gives a pink bubble and the `attention` pose); `sprites.test.ts` (the draft pose uses only the design's colours) |
| FR-10.05 no duplicates, stale runs expire, quiet hours and categories apply | `claudeRuns.test.ts` (repeats collapsed, stale runs forgotten); `src/main/claudeCode.ts` sends every alert through the notifier (`notify.test.ts`) |
| FR-10.06 on/off toggle and threshold, on by default | `src/main/settings.ts` (`DEFAULT_CLAUDE_CODE`, `mergeClaudeCode`); Settings screen |
| FR-10.07 / FR-10.08 SMOI never edits Claude Code settings; 2 s curl timeout | `desktop/scripts/print-claude-hooks.mjs` prints the config only; every hook uses `-m 2` and `|| true` |
| End-to-end with curl and a real Claude Code session | `desktop/scripts/claude-hook-demo.sh`; owner's manual checklist (pending) |
