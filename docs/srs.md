# SMOI: Software Requirements Specification

Personal desktop intelligence companion

| Attribute | Value |
| --- | --- |
| Document | Software Requirements Specification |
| Version | 0.2 (draft) |
| Date | 2026-11-02 |
| Product | SMOI |
| Knowledge base | SMOI Brain |
| Desktop platform | Windows 11 |
| Interface | Pixel-art frog companion (art, palette, fonts and personality defined in `docs/design/smoi-character-design.html`) |
| Backend | Java 21, Spring Boot 4, PostgreSQL + pgvector |
| Intelligence | Voice, retrieval-augmented generation (RAG), LLM |

## Changes from v0.1

- The product is renamed from MISO to **SMOI**. The personal knowledge base is named **SMOI Brain**.
- Every requirement has a unique ID in the form `FR-xx.yy` or `NFR-xx.yy`. IDs from v0.1 are kept
  where the requirement survives, so FR-06.01 in v0.1 is still FR-06.01.
- The default voice shortcut is now `Ctrl+Alt+J` (FR-03.01).
- FR-01.03 lists the 12 animation states in the character design.
- These moved to [Future work](#6-future-work): FR-07 (job radar), FR-09 (sync and iOS), FR-04.07,
  NFR-08.02 (iOS). NFR-02.02 and the "discovered opportunities" part of FR-02.05 also moved, because
  they only make sense with FR-09 and FR-07. The iOS row was removed from the attribute table.
- FR-05 gains Gmail drafts, links between reminders and drafts, cancelling a reminder when its draft is gone,
  detecting revoked Google access (FR-05.08 to FR-05.12), and an explicit ban on sending or deleting email (FR-05.13).
- FR-06 gains local-directory indexing as its own requirement (FR-06.11, split from FR-06.02) and citation
  validation (FR-06.12).
- FR-10 (Claude Code notifications) and NFR-03.16 were added as Phase 10. FR-06.11 moved from Phase 8 to
  Phase 9.
- New security requirements cover prompt injection and per-user data isolation (NFR-03.08 to NFR-03.15).
- The new NFR-09 holds measurable quality requirements for retrieval, citations and intent detection.
  Their targets are `TBD` until they are measured.
- Untestable wording ("intuitive", "gracefully", "secure", "appropriate", "concise", "normal operating
  conditions") was replaced with conditions that can be checked.
- The release plan was replaced by the ten build phases in [Section 5](#5-build-phases).

## Conventions

- **Shall** marks a mandatory requirement.
- **Target** values are acceptance targets, not measured results. A number becomes a measured result only
  when a script in this repository produces it, and the document names that script.
- **TBD** marks a value to be set once it has been measured, normally in Phase 3 (quality) or Phase 4
  (performance).
- **Consequential action:** any action that creates, changes or deletes data in an external service
  (Google Calendar events, Gmail drafts), or permanently deletes the user's local data.
- **Reference environment:** the hardware, OS, dataset and network conditions that performance targets
  are measured on. It will be defined in Phase 4 and recorded in `docs/` together with the benchmark script.

---

## 1. Functional requirements (FR)

### FR-01: Desktop companion

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-01.01 | The system shall display the SMOI pixel-art frog on the Windows desktop in a frameless, transparent, always-on-top window, using sprites from `docs/design/smoi-character-design.html`. | 6 |
| FR-01.02 | The user shall be able to drag the frog anywhere on any connected monitor. Its position shall be saved and restored on next launch. | 6 |
| FR-01.03 | The frog shall support the 12 animation states in the character design: idle, happy, sleeping, working, thinking, surprised, annoyed, celebrating, listening, speaking, walking and error. | 6 |
| FR-01.04 | Clicking the frog shall open the menu panel defined in the character design. The menu panel shall open the dashboard. | 6 |
| FR-01.05 | The system shall provide a system-tray icon with at least: show/hide frog, open dashboard, pause notifications and quit. Launch at Windows sign-in shall be available and off by default. On quit, all changes the user has saved shall persist and be visible on the next launch. | 6, 9 |
| FR-01.06 | The user shall be able to configure the companion's personality settings (FR-08.02), appearance and notification behaviour. Appearance options are limited to variants defined in the character design. | 6 |

### FR-02: Tasks and reminders

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-02.01 | The user shall be able to create, edit, delete and complete tasks. | 7 |
| FR-02.02 | A task shall support a priority, a category, a due date and a description. | 7 |
| FR-02.03 | The system shall support one-time reminders and recurring reminders (daily, weekly, monthly, or custom weekdays). | 7 |
| FR-02.04 | While the desktop app is running, a reminder shall produce a desktop notification within 60 seconds of its scheduled time. | 7 |
| FR-02.05 | The user shall be able to convert an email into a task, with a link back to the source email. | 8 |
| FR-02.06 | The system shall keep the completion time of each completed task and list overdue tasks (due date passed, not completed). | 7 |

### FR-03: Voice interaction

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-03.01 | A global keyboard shortcut shall start voice interaction. The default is `Ctrl+Alt+J`, and the user can change it. If the operating system refuses to register the shortcut, the system shall tell the user and ask for another. | 7 |
| FR-03.02 | When the shortcut is pressed, the frog shall appear in the listening state and the microphone shall start capturing. | 7 |
| FR-03.03 | Captured speech shall be converted to text by a speech-to-text engine behind a provider interface chosen by configuration. | 7 |
| FR-03.04 | The system shall classify each command into one intent from a documented intent list (for example: create task, create reminder, ask SMOI Brain, list events, create event, draft email), or "unknown". Accuracy is specified in NFR-09.06. | 7 |
| FR-03.05 | Each recognised intent shall be routed to the module that handles it: tasks, calendar, email or knowledge retrieval. | 7, 8 |
| FR-03.06 | The system shall display the interpreted command before acting. Consequential actions shall run only after the user confirms. | 7 |
| FR-03.07 | The user shall be able to cancel voice interaction with `Esc` or by pressing the shortcut again. The microphone shall be released within 1 second of cancelling, and voice input can be disabled entirely in settings. | 7 |

### FR-04: Google Calendar

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-04.01 | The system shall connect to Google using the OAuth 2.0 authorization code flow with PKCE, requesting only the scopes listed in NFR-03.05. | 8 |
| FR-04.02 | The system shall show upcoming events from the user's primary Google Calendar. | 8 |
| FR-04.03 | The user shall be able to create events from typed text or voice. | 8 |
| FR-04.04 | The user shall be able to change or delete events. Before any change, the system shall show the event's details and the proposed change, and apply it only after the user confirms. | 8 |
| FR-04.05 | When an event is created or changed, the system shall list any overlapping events in the primary calendar before the user confirms. | 8 |
| FR-04.06 | The user shall be able to set reminder intervals for events (for example 10 minutes or 1 hour before). | 8 |

### FR-05: Email intelligence (Gmail)

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-05.01 | The system shall connect to Gmail through the OAuth 2.0 flow in FR-04.01, requesting only the Gmail scopes listed in NFR-03.05. | 8 |
| FR-05.02 | The system shall retrieve messages from the connected account that fall inside the user's configured filters (date range and labels). | 8 |
| FR-05.03 | The system shall classify each retrieved email into exactly one category: recruitment, personal, academic, important or promotional. Accuracy is specified in NFR-09.07. | 8 |
| FR-05.04 | Emails classified as important shall produce a notification, subject to FR-08.04 and FR-08.06. | 8 |
| FR-05.05 | The system shall summarise an email in at most 80 words. Each summary shall link to its source email. | 8 |
| FR-05.06 | The user shall be able to create tasks and reminders from an email. | 8 |
| FR-05.07 | For each email shown, the system shall provide a link that opens the original message in Gmail. | 8 |
| FR-05.08 | The system shall be able to create Gmail drafts for the user to review in Gmail. A draft is created only after the user confirms its recipient, subject and body. | 8 |
| FR-05.09 | The system shall be able to update drafts it created, after the user confirms the change. It shall not change drafts it did not create. | 8 |
| FR-05.10 | The user shall be able to link a reminder to a draft ("remind me to send this tomorrow at 9"). | 8 |
| FR-05.11 | If a linked draft no longer exists (sent or deleted by the user in Gmail), the system shall cancel its reminder before the reminder fires and tell the user why. | 8 |
| FR-05.12 | When Google rejects SMOI's credentials (for example access revoked or refresh token expired), the system shall pause Calendar and Gmail features, keep all local data, and ask the user to reconnect. No other features are affected. | 8 |
| FR-05.13 | The system shall never send, delete or trash email. The backend shall have no code path that calls Gmail's send, delete or trash operations, and an automated test shall check this. | 8 |

### FR-06: SMOI Brain (knowledge base and RAG)

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-06.01 | The user shall be able to upload PDF, DOCX and TXT files to SMOI Brain. Upload returns immediately with a document ID and status. Indexing happens in the background. | 1 |
| FR-06.02 | The system shall be able to index authorised emails and their attachments. | 8 |
| FR-06.03 | The system shall extract text, clean it and split it into chunks. Each chunk records its source location (page or section) for citations. | 1 |
| FR-06.04 | The system shall generate and store a vector embedding for every chunk, using an embedding provider behind an interface chosen by configuration. | 1 |
| FR-06.05 | The system shall support keyword retrieval, vector retrieval and hybrid retrieval. The mode is selectable per request. | 2 |
| FR-06.06 | The system shall generate answers using only retrieved chunks as sources. When the sources don't cover the question, it shall say it doesn't know. | 2 |
| FR-06.07 | Every answer shall include citations identifying the document, the page or section, and the chunk. | 2 |
| FR-06.08 | The user shall be able to query SMOI Brain by typed text and by voice. | 2, 7 |
| FR-06.09 | The system shall summarise a document and compare two documents, with citations. | 2 |
| FR-06.10 | The user shall be able to delete an indexed source. Deleting it removes its chunks and vectors, and they no longer appear in any retrieval result. | 1 |
| FR-06.11 | The user shall be able to choose local directories to index. Only files in supported formats inside the chosen directories are indexed. | 9 |
| FR-06.12 | Every citation in an answer shall refer to a chunk that was retrieved for that query. The backend shall reject an answer that cites anything else. | 2 |

### FR-08: Personality and notifications

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-08.01 | The user shall be able to choose the companion's conversational personality within the personality defined in the character design. | 7 |
| FR-08.02 | The user shall be able to set humour, sarcasm, friendliness and reminder strictness, each on a fixed scale (for example 0 to 4). | 7 |
| FR-08.03 | The companion's speech-bubble responses shall reflect the triggering event (for example a reminder or finished indexing) and the settings in FR-08.02. | 7 |
| FR-08.04 | The user shall be able to set which notification categories are enabled, their priority levels, and quiet hours during which non-critical notifications are held. | 7 |
| FR-08.05 | Notifications shall be shown either as speech bubbles (styled as in the character design) or as native Windows notifications, depending on the user's setting. | 6, 7 |
| FR-08.06 | A non-critical notification of the same category and source shall not repeat within a configurable cooldown period (default 30 minutes). | 7 |

### FR-10: Claude Code notifications

SMOI tells the user when a Claude Code session on the same machine finishes a long run or is blocked
waiting for permission. Claude Code's hooks call a local endpoint in the desktop app.

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-10.01 | The desktop app shall accept hook events on `POST /claude/start`, `/claude/done` and `/claude/waiting`, on a listener bound to 127.0.0.1 only. | 10 |
| FR-10.02 | SMOI shall track each run by `session_id` and compute its duration from start to done. Parallel sessions are tracked independently. | 10 |
| FR-10.03 | On done, SMOI shall celebrate with a speech bubble showing the duration only if the run took at least a configurable threshold (default 3 minutes). A done event with no matching start shall produce no celebration. | 10 |
| FR-10.04 | On waiting, SMOI shall always alert the user with a state distinct from the celebration, because the run is blocked. | 10 |
| FR-10.05 | Repeated events for the same run shall not produce duplicate alerts. Runs that start and never finish shall expire without an alert. Mute and quiet hours (FR-08.04) shall apply. | 10 |
| FR-10.06 | The user shall be able to turn Claude Code notifications on or off in settings. They are on by default. | 10 |
| FR-10.07 | SMOI shall not change the user's Claude Code settings. The repository shall provide a setup document and a script that prints the hook configuration for the user to merge. | 10 |
| FR-10.08 | The hook commands shall use a short timeout (at most 2 seconds), so that Claude Code is not slowed when SMOI is closed. | 10 |

---

## 2. Non-functional requirements (NFR)

### NFR-01: Performance

These targets are proposed acceptance values, not measurements. They are measured on the reference
environment by a benchmark script added in Phase 4.

| ID | Requirement | Phase |
| --- | --- | --- |
| NFR-01.01 | The frog shall be visible within 5 seconds of the desktop app starting (target, p95). | 6 |
| NFR-01.02 | The dashboard shall accept input within 2 seconds of being opened (target, p95). | 6 |
| NFR-01.03 | Creating or updating a task shall complete within 500 ms (target, p95, local backend). | 7 |
| NFR-01.04 | Visible voice feedback (listening state) shall appear within 500 ms of the shortcut, excluding OS microphone permission prompts (target, p95). | 7 |
| NFR-01.05 | Retrieval (excluding LLM generation) shall return within 5 seconds (target, p95) on the reference dataset. | 2, 4 |

### NFR-02: Reliability and availability

| ID | Requirement | Phase |
| --- | --- | --- |
| NFR-02.01 | Tasks and reminders stored locally shall remain available and editable when the network is down. | 7 |
| NFR-02.03 | Retrying a request (for example after a timeout) shall never create a duplicate task, calendar event, draft or document. A fault-injection test that repeats each create request shall find zero duplicates. | 1, 7, 8 |
| NFR-02.04 | After the backend or desktop app is killed (for example by a crash or `taskkill /F`) and restarted, no committed data shall be lost and in-progress background jobs shall be retried until they finish or reach the dead-letter state. An automated test shall check this for ingestion. | 1, 4 |
| NFR-02.05 | Scheduled reminders shall fire on the desktop when the backend or the internet is unreachable. | 7 |
| NFR-02.06 | Failed background jobs shall be retried with exponential backoff up to a configurable limit, then moved to a dead-letter state that records the error reason. | 1 |
| NFR-02.07 | When an external dependency (LLM, embedding provider, reranker, Google APIs) is unavailable, the affected request shall fail with a clear error or a documented fallback within a configured timeout, and features that don't depend on it shall keep working. | 4 |

### NFR-03: Security

| ID | Requirement | Phase |
| --- | --- | --- |
| NFR-03.01 | All traffic that leaves the user's machine shall use TLS 1.2 or later. A backend running locally shall listen only on `127.0.0.1`. | 0, 9 |
| NFR-03.02 | Passwords shall be stored only as BCrypt hashes. Access tokens shall be signed JWTs (HS256 with a key of at least 256 bits) with an expiry of at most 1 hour. Login shall return the same response for an unknown email and a wrong password. | 0 |
| NFR-03.03 | OAuth tokens and other credentials shall be encrypted at rest and shall never appear in logs, API responses or the repository. | 8 |
| NFR-03.04 | Every request for user-owned data shall be scoped to the authenticated user. A request for another user's resource shall get the same response as a request for a resource that does not exist (404). | 1 onwards |
| NFR-03.05 | Google scopes shall be limited to: Calendar events read/write (`calendar.events`), Gmail read-only (`gmail.readonly`) and Gmail compose for drafts (`gmail.compose`). Adding a scope requires an ADR. | 8 |
| NFR-03.06 | Consequential actions shall run only after explicit user confirmation that shows exactly what will happen. | 7, 8 |
| NFR-03.07 | Indexed documents, chunks and vectors shall be readable only through authenticated, user-scoped API calls. | 1, 2 |
| NFR-03.08 | **Prompt injection, data/instruction separation:** retrieved content (documents, emails, calendar entries) shall be placed in prompts as clearly delimited data, separate from system instructions. It shall never be treated as instructions to SMOI. | 2, 5 |
| NFR-03.09 | **Prompt injection, structured actions only:** the LLM may only propose actions as structured output. The backend shall validate every proposal against an allowlist of action types and parameter schemas, and shall reject and log anything else. | 5, 7 |
| NFR-03.10 | **Prompt injection, no action from content:** no text inside retrieved content shall cause an action to run without the user's confirmation. An injection test corpus (documents and emails containing instructions such as "delete all tasks" or "send this email") shall produce zero executed actions. | 5 |
| NFR-03.11 | **Prompt injection, no access widening:** query text and retrieved content shall not change which user's data is searched or which tools are available. Retrieval is always scoped to the authenticated user. | 2, 5 |
| NFR-03.12 | **Data isolation tests:** for every endpoint that reads, changes or deletes user-owned data, an automated test shall check that user B cannot read, change or delete user A's data. The target is zero failures, and these tests run in CI. | 1 onwards |
| NFR-03.13 | **Data isolation in storage:** every user-owned table shall have a `user_id` column. Every query on such a table shall filter by `user_id`, including in vector and keyword search. | 1 onwards |
| NFR-03.14 | Repeated failed logins for one account or IP address shall be throttled after a configurable number of attempts (default TBD). | 5 |
| NFR-03.15 | Secrets shall be supplied only through environment variables (`.env` locally, which is gitignored). CI shall run a secret scan on every push. | 0, 5 |
| NFR-03.16 | The Claude Code hook endpoint shall reject requests without the shared secret from the environment, passed in a request header. Hook payloads are untrusted: they shall be validated against a schema, and prompt text and file contents shall never be logged or stored. | 10 |

### NFR-04: Privacy

| ID | Requirement | Phase |
| --- | --- | --- |
| NFR-04.01 | The system shall access an external data source (Google account, local directory) only after the user explicitly connects or selects it. | 8 |
| NFR-04.02 | Whenever the microphone is capturing, the frog shall be in the listening state and a recording indicator shall be visible. | 7 |
| NFR-04.03 | The microphone shall capture audio only after the user activates voice (FR-03.01). No audio shall be captured in the background. | 7 |
| NFR-04.04 | The user shall be able to disconnect any integration and delete their indexed data. Deleted data shall no longer appear in any result. | 1, 8 |
| NFR-04.05 | The user shall be able to choose local-only LLM and embedding providers, so that no document or email content leaves their machine. The active providers shall be shown in settings. | 2 |
| NFR-04.06 | Every category of stored personal data shall be listed in `docs/` with its purpose and retention period. No data shall be stored that is not on that list. | 5 |

### NFR-05: Usability and accessibility

| ID | Requirement | Phase |
| --- | --- | --- |
| NFR-05.01 | The common actions (create a task, ask SMOI Brain a question, start voice) shall be reachable in at most 2 interactions from the frog. | 6, 7 |
| NFR-05.02 | All screens shall use only the palette, fonts, speech bubble and panel styles in the character design. | 6 |
| NFR-05.03 | Body text shall meet WCAG 2.2 AA contrast (4.5:1). Notification states shall differ by more than colour alone (for example icon or text). | 6 |
| NFR-05.04 | Every dashboard control shall be reachable and usable with the keyboard alone, with a visible focus indicator. | 6 |
| NFR-05.05 | The user shall be able to change keyboard shortcuts and notification behaviour in settings. | 7 |
| NFR-05.06 | When Windows animation effects are turned off, or the user turns on reduced motion in SMOI, the frog shall use still poses in place of looping animations. | 6 |

### NFR-06: Scalability

| ID | Requirement | Phase |
| --- | --- | --- |
| NFR-06.01 | The API shall keep no per-user state in memory between requests, so two backend instances sharing one database pass the full integration suite. | 4 |
| NFR-06.02 | Document ingestion shall run asynchronously. Several workers shall process documents concurrently, and no job is processed by two workers at once. | 1 |
| NFR-06.03 | Retrieval latency shall be measured at increasing corpus sizes (for example 1k, 10k and 100k chunks). The p95 target at each size is TBD. | 4 |
| NFR-06.04 | API handling and background workers shall be able to run as separate processes, selected by configuration. | 4 |

### NFR-07: Maintainability

| ID | Requirement | Phase |
| --- | --- | --- |
| NFR-07.01 | Each module (auth, ingestion, retrieval, tasks, integrations) shall live in its own package with a documented responsibility. | 0 onwards |
| NFR-07.02 | The API used by the desktop app shall be documented as an OpenAPI specification generated from the code. | 2 |
| NFR-07.03 | Every feature shall ship with automated tests. CI shall run all tests on every push and pull request. | 0 onwards |
| NFR-07.04 | Logs shall be structured (JSON) and include a request ID. Logs shall not contain document content, email content, passwords or tokens. | 4 |
| NFR-07.05 | The desktop app and backend shall be releasable independently. The API shall be versioned. | 9 |

### NFR-08: Compatibility

| ID | Requirement | Phase |
| --- | --- | --- |
| NFR-08.01 | The desktop app shall run on Windows 11. | 6 |
| NFR-08.03 | The frog shall be movable between monitors. If its saved monitor is no longer connected, it shall appear on the primary monitor. | 6 |
| NFR-08.04 | The pixel art shall stay crisp (integer scaling, no blurring) at Windows display scaling from 100% to 200%. | 6 |
| NFR-08.05 | Losing or regaining network connectivity shall not lose any saved data. | 7 |

### NFR-09: Answer and intent quality

Each metric is produced by a script in `eval/` on a versioned, labelled dataset. Reported numbers shall
name the script, the dataset version and the commit. Targets stay `TBD` until a baseline has been measured
(Phase 3).

| ID | Requirement | Measure | Target | Phase |
| --- | --- | --- | --- | --- |
| NFR-09.01 | Retrieval shall find the relevant chunks. | Recall@5 on the retrieval eval set, reported per retrieval mode | TBD | 3 |
| NFR-09.02 | Retrieval shall rank relevant chunks near the top. | MRR@10 on the retrieval eval set, per mode | TBD | 3 |
| NFR-09.03 | Citations shall support the claims they are attached to. | Citation precision: share of cited chunks labelled as supporting their claim | TBD | 3 |
| NFR-09.04 | Citations shall refer only to retrieved chunks (enforced by FR-06.12). | Share of citations that refer to a retrieved chunk | 100% (hard rule) | 2, 3 |
| NFR-09.05 | SMOI shall say it doesn't know when the sources don't cover a question. | Share of unanswerable eval questions answered with "don't know"; also the share of answerable questions wrongly refused | TBD | 3 |
| NFR-09.06 | Voice and typed commands shall be classified into the right intent. | Accuracy and macro-F1 on the labelled intent set | TBD | 3, 7 |
| NFR-09.07 | Emails shall be classified into the right category. | Macro-F1 on a labelled email set | TBD | 8 |
| NFR-09.08 | Answer latency shall be reported alongside quality. | p50 and p95 time per stage (retrieval, rerank, generation) | TBD | 3, 4 |

---

## 3. Constraints

- SMOI never sends or deletes email (FR-05.13).
- Retrieved content is untrusted data and can never trigger an action (NFR-03.08 to NFR-03.11).
- LLM and embedding providers sit behind interfaces chosen by configuration (FR-06.04, NFR-04.05).
- The character design file is the source of truth for SMOI's appearance and personality (NFR-05.02).

## 4. Verification

Each requirement is verified by an automated test, an evaluation script or a documented manual check.
A traceability matrix linking requirement IDs to tests will be added as features are built.

## 5. Build phases

| Phase | Build | Main requirements |
| --- | --- | --- |
| 0 | Setup: repo, auth, CI, Docker Compose | NFR-03.01, NFR-03.02, NFR-03.15, NFR-07.03 |
| 1 | Document ingestion | FR-06.01, FR-06.03, FR-06.04, FR-06.10, NFR-02.03, NFR-02.04, NFR-02.06, NFR-03.04, NFR-03.12, NFR-03.13, NFR-06.02 |
| 2 | Retrieval and cited answers | FR-06.05 to FR-06.09, FR-06.12, NFR-01.05, NFR-03.08, NFR-03.11, NFR-04.05, NFR-07.02 |
| 3 | Evaluation | NFR-09.01 to NFR-09.06, NFR-09.08 |
| 4 | Observability and resilience | NFR-02.07, NFR-06.01, NFR-06.03, NFR-06.04, NFR-07.04, reference environment |
| 5 | Security | NFR-03.09, NFR-03.10, NFR-03.14, NFR-04.06 |
| 6 | Desktop frog | FR-01, FR-08.05, NFR-01.01, NFR-01.02, NFR-05, NFR-08 |
| 7 | Tasks, reminders and voice | FR-02, FR-03, FR-08, NFR-01.03, NFR-01.04, NFR-02.01, NFR-02.05, NFR-04.02, NFR-04.03 |
| 8 | Calendar and Gmail | FR-02.05, FR-04, FR-05, FR-06.02, NFR-03.03, NFR-03.05, NFR-04.01, NFR-09.07 |
| 9 | Packaging | FR-01.05 (launch at sign-in, installer), FR-06.11, NFR-07.05 |
| 10 | Claude Code notifications | FR-10, NFR-03.16 |

If time runs short, Phases 0 to 3 plus a basic Phase 6 frog and Phase 9 form a complete project.

## 6. Future work

These requirements are kept for reference and are out of scope for the current phases. Their v0.1 IDs are kept.

### FR-07: Job and internship radar

- FR-07.01 The user shall be able to set job preferences: role, location, employment type and keywords.
- FR-07.02 The system shall retrieve job listings from supported job sources.
- FR-07.03 The system shall detect and remove duplicate listings.
- FR-07.04 The system shall rank opportunities by the user's preferences.
- FR-07.05 The system shall notify the user about new relevant opportunities.
- FR-07.06 The user shall be able to save opportunities and track application status.
- FR-07.07 The system shall link to the original listing and application page.
- (From FR-02.05 in v0.1) The user shall be able to convert discovered opportunities into tasks.

### FR-09: Cloud synchronisation and iOS

- FR-09.01 Authentication shall work across supported devices.
- FR-09.02 Tasks, reminders, preferences and related data shall sync between Windows and iOS.
- FR-09.03 Previously synced tasks shall be available offline.
- FR-09.04 Changes made offline shall sync when connectivity returns.
- FR-09.05 Push notifications shall be delivered through mobile notification services.
- FR-09.06 The user shall be able to create, edit and complete tasks in the iOS app.
- FR-09.07 Synced data shall stay consistent across registered devices.

### Related items

- FR-04.07 Calendar information shall sync with the desktop and iOS apps.
- NFR-02.02 Pending sync operations shall resume after connectivity returns (depends on FR-09).
- NFR-08.02 The mobile app shall support compatible iOS devices.
