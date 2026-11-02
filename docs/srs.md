Let's start with the Software Requirements Specification (SRS) for MISO. We'll define the functional and non-functional requirements before moving into architecture, UI design or implementation.

I'll structure this like a proper engineering project document, with uniquely numbered requirements so we can later map each one to its verification and testing approach.

# MISO — Software Requirements Specification

# MISO 🐸

Personal Desktop Intelligence Companion

Document: Software Requirements Specification · Version 0.1 · Draft

| Attribute        | Specification            |
| ---------------- | ------------------------ |
| Product          | MISO                     |
| Desktop platform | Windows 11               |
| Mobile platform  | iOS                      |
| Interface        | Pixel-art frog companion |
| Theme            | Pastel cozy              |
| Backend          | Spring Boot              |
| Intelligence     | Voice + RAG + AI         |
| Synchronization  | Cloud-based              |

## 1. Functional Requirements (FR)

Functional requirements describe what the system shall do.

### FR-01: Desktop Companion Management

1. The system shall display an interactive pixel-art frog companion on the Windows desktop.
2. The system shall support dragging and repositioning the companion across the desktop.
3. The system shall provide multiple character animation states, including idle, walking, sleeping, happy, surprised and annoyed.
4. The system shall provide an expandable dashboard accessible through the desktop companion.
5. The system shall support system-tray controls, application startup and graceful shutdown.
6. The system shall allow users to customize the companion's personality, appearance and notification behaviour.

### FR-02: Task and Reminder Management

1. The system shall allow users to create, edit, delete and complete tasks.
2. The system shall allow users to assign priorities, categories, due dates and descriptions to tasks.
3. The system shall support one-time and recurring reminders.
4. The system shall generate desktop notifications for scheduled reminders.
5. The system shall allow users to convert incoming emails and discovered opportunities into tasks.
6. The system shall maintain task completion history and overdue task information.

### FR-03: Voice Interaction

1. The system shall support a configurable global keyboard shortcut, with `J + K` as the default, to activate voice interaction.
2. The system shall display the companion and activate the microphone when the configured shortcut is triggered.
3. The system shall convert captured speech into text using a speech-to-text engine.
4. The system shall interpret natural-language commands and identify the corresponding intent.
5. The system shall route voice commands to the appropriate system module, including tasks, calendar, email and knowledge retrieval.
6. The system shall display the interpreted command and provide a confirmation mechanism for consequential actions.
7. The system shall allow users to cancel voice interactions and control microphone access.

### FR-04: Google Calendar Integration

1. The system shall support secure Google account authentication through OAuth 2.0.
2. The system shall retrieve upcoming events from the user's connected Google Calendar.
3. The system shall allow users to create calendar events using natural-language text or voice commands.
4. The system shall allow users to modify and delete calendar events with appropriate confirmation.
5. The system shall identify scheduling conflicts when creating or modifying events.
6. The system shall support event reminders and configurable notification intervals.
7. The system shall synchronize calendar-related information with the desktop and iOS applications.

### FR-05: Email Intelligence

1. The system shall support secure Gmail integration.
2. The system shall retrieve authorized email information from the connected Gmail account.
3. The system shall classify incoming emails into categories such as recruitment, personal, academic, important and promotional.
4. The system shall identify high-priority emails and generate corresponding notifications.
5. The system shall generate concise summaries of retrieved emails.
6. The system shall allow users to convert relevant email information into tasks and reminders.
7. The system shall provide access to the original email from the application.

### FR-06: Personal Knowledge Base and RAG

1. The system shall allow users to upload and index supported documents, including PDF, DOCX and TXT files.
2. The system shall support indexing of authorized emails, attachments and selected local directories.
3. The system shall extract, process and divide document content into searchable chunks.
4. The system shall generate and store vector embeddings for indexed content.
5. The system shall support semantic and keyword-based retrieval.
6. The system shall generate contextual answers using retrieved information.
7. The system shall provide source references for generated answers.
8. The system shall allow users to search their personal knowledge base using text and voice queries.
9. The system shall support document summarization and comparison.
10. The system shall allow users to remove indexed sources and their associated knowledge data.

### FR-07: Job and Internship Radar

1. The system shall allow users to configure job preferences, including role, location, employment type and keywords.
2. The system shall retrieve job listings from supported job sources.
3. The system shall identify and eliminate duplicate job listings.
4. The system shall rank opportunities based on configured user preferences.
5. The system shall notify users about newly discovered relevant opportunities.
6. The system shall allow users to save opportunities and track application statuses.
7. The system shall provide links to original job listings and application pages.

### FR-08: Personality and Notification Management

1. The system shall allow users to customize the companion's conversational personality.
2. The system shall support configurable humour, sarcasm, friendliness and reminder strictness.
3. The system shall generate contextual responses based on incoming events and user preferences.
4. The system shall allow users to configure notification categories, priority levels and quiet hours.
5. The system shall support different notification styles, including speech bubbles and native desktop notifications.
6. The system shall prevent repeated non-critical notifications within configurable cooldown periods.

### FR-09: Cloud Synchronization and iOS Integration

1. The system shall support secure user authentication across supported devices.
2. The system shall synchronize tasks, reminders, preferences and relevant application data between Windows and iOS.
3. The system shall support offline access to previously synchronized tasks.
4. The system shall synchronize locally modified data when network connectivity is restored.
5. The system shall provide push notifications through supported mobile notification services.
6. The system shall allow users to create, edit and complete tasks from the iOS application.
7. The system shall maintain consistency of synchronized data across registered devices.

## 2. Non-Functional Requirements (NFR)

Non-functional requirements define how well the system shall operate.

### NFR-01: Performance

1. The desktop companion shall initialize within 5 seconds under the defined target test environment.
2. The dashboard shall become interactive within 2 seconds after being opened under normal operating conditions.
3. Local task creation and updates shall complete within 500 milliseconds under normal operating conditions.
4. The system shall display voice interaction feedback within 500 milliseconds of shortcut activation, excluding microphone permission prompts and operating-system delays.
5. The system shall process and return standard knowledge retrieval responses within 5 seconds under the defined test dataset and network conditions, excluding external LLM generation latency.

### NFR-02: Reliability and Availability

1. The system shall preserve locally stored tasks and reminders during temporary network failures.
2. The system shall recover pending synchronization operations after network connectivity is restored.
3. The system shall prevent duplicate task and calendar event creation during retry operations.
4. The system shall recover gracefully from application crashes and unexpected service interruptions.
5. The system shall maintain scheduled local reminders independently of cloud service availability.

### NFR-03: Security

1. The system shall use encrypted communication channels for client-server communication.
2. The system shall implement secure authentication and authorization mechanisms.
3. The system shall securely store OAuth tokens and other sensitive credentials.
4. The system shall restrict access to user data based on authenticated account ownership.
5. The system shall request only the permissions necessary for each external integration.
6. The system shall require user confirmation before executing consequential external actions.
7. The system shall protect indexed documents and retrieved knowledge from unauthorized access.

### NFR-04: Privacy

1. The system shall obtain explicit user consent before accessing external data sources.
2. The system shall provide visible microphone activation and recording indicators.
3. The system shall not continuously record audio without explicit user activation.
4. The system shall allow users to disconnect integrations and delete their indexed data.
5. The system shall provide configurable controls over AI processing and data sharing.
6. The system shall minimize the collection and retention of personal information.

### NFR-05: Usability and Accessibility

1. The system shall provide an intuitive interface requiring minimal navigation for common tasks.
2. The system shall maintain a consistent visual design across supported application modules.
3. The system shall provide readable text, clear interaction feedback and distinguishable notification states.
4. The system shall support keyboard navigation for dashboard interactions.
5. The system shall allow users to customize keyboard shortcuts and notification behaviour.
6. The system shall support adjustable animation behaviour and reduced-motion preferences.

### NFR-06: Scalability

1. The backend shall support an increasing number of registered users and connected devices without requiring fundamental architectural changes.
2. The document ingestion pipeline shall support asynchronous processing of multiple documents.
3. The knowledge retrieval system shall support increasing document collections through indexing and retrieval optimization.
4. The system shall support independent scaling of background processing and API workloads.

### NFR-07: Maintainability

1. The system shall use modular components with clearly defined responsibilities.
2. The system shall maintain documented API contracts between desktop, mobile and backend components.
3. The system shall provide automated tests for critical business logic and integrations.
4. The system shall maintain structured application logs and error information.
5. The system shall support independent updates to the desktop application, backend and mobile application.

### NFR-08: Compatibility and Portability

1. The desktop application shall support Windows 11.
2. The mobile application shall support compatible iOS devices.
3. The desktop application shall support multiple monitor configurations.
4. The system shall handle different display resolutions and scaling configurations.
5. The application shall support network connectivity changes without losing persisted user data.

## 3. Requirements summary

# 9

Functional categories

FR-01 to FR-09

# 8

Quality categories

NFR-01 to NFR-08

Coverage

- Desktop companion
- Tasks and reminders
- Voice activation
- Google Calendar
- Gmail intelligence
- RAG and personal memory
- Job discovery
- Cloud synchronization
- Security, privacy and performance

## 4. Important scope distinction

I recommend treating these as the complete product requirements, but implementing them in stages.

| Release   | Requirements                                    |
| --------- | ----------------------------------------------- |
| MVP       | FR-01, FR-02, basic FR-03, NFR essentials       |
| Release 2 | FR-04, FR-08                                    |
| Release 3 | FR-05, FR-06                                    |
| Release 4 | FR-07                                           |
| Release 5 | FR-09 and complete cross-device synchronization |

This prevents the first release from becoming too large.

A note on requirement verification: The numerical performance targets above are proposed acceptance targets, not measured guarantees. We'll need to define hardware, dataset size, network conditions and test procedures before treating them as verified.

## 5. What should we document next?

My recommendation is to create the next SRS sections in this order:

1. System overview and scope.
2. User roles and use cases.
3. External interface requirements.
4. System constraints and assumptions.
5. Requirement-to-verification traceability matrix.

We should also give every individual requirement a unique identifier, such as `FR-03.01` and `NFR-01.02`, when preparing the formal submission document.

That will make it possible to map each requirement directly to its verification approach without ambiguity.