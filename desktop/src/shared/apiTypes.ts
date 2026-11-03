/**
 * Shapes of the backend's JSON, as the desktop app uses them. They mirror the Java records in
 * backend/src/main/java/com/smoi (DocumentController, AnswerResult, ProvidersController, ...).
 */
export type DocumentStatus = 'queued' | 'processing' | 'indexed' | 'failed';

export interface DocumentInfo {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  indexedAt: string | null;
  hostedLlmAllowed: boolean;
}

export interface ChunkInfo {
  id: string;
  index: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  tokenCount: number;
  embeddingModel: string;
}

/** Where a cited or retrieved passage comes from. */
export interface SourceRef {
  label: string;
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
}

export interface Passage extends SourceRef {
  content: string;
}

export type Outcome = 'answered' | 'dont_know' | 'refused' | 'citation_rejected' | 'llm_unavailable';

export interface AnswerResult {
  outcome: Outcome;
  answer: string | null;
  message: string | null;
  citations: SourceRef[] | null;
  invalidCitations: string[] | null;
  refusalCategory: string | null;
  provider: string | null;
  model: string | null;
  mode: string | null;
  sourcesGiven: number;
  excludedDocuments: number;
  omittedForContext: number;
  truncated: boolean;
  passages: Passage[] | null;
}

export interface LoginResult {
  accessToken: string;
  tokenType: string;
  expiresAt: string;
}

export interface Me {
  id: string;
  email: string;
  createdAt: string;
}

/** GET /api/settings/providers. "hosted" means content is sent off this machine (NFR-04.05). */
export interface Providers {
  llm: { provider: string; model: string; hosted: boolean };
  embedding: { model: string; hosted: boolean };
  reranker: { enabled: boolean; model: string | null; hosted: boolean };
  chunking: { maxTokens: number; overlapTokens: number };
}

/** Events of POST /api/query/stream, in order: sources, delta*, then result or error. */
export type StreamEvent =
  | { type: 'sources'; sources: SourceRef[] }
  | { type: 'delta'; text: string }
  | { type: 'result'; result: AnswerResult }
  | { type: 'error'; message: string }
  /** The connection ended without a result or error event. */
  | { type: 'cut'; message: string };

/** Why a request failed, in words the user can act on. Never hidden behind personality. */
export type ApiErrorKind =
  | 'unreachable' | 'timeout' | 'bad_credentials' | 'session_expired' | 'rate_limited'
  | 'not_found' | 'gone' | 'invalid' | 'conflict' | 'too_large' | 'unsupported' | 'unavailable' | 'server';

export interface ApiFailure {
  kind: ApiErrorKind;
  message: string;
  status?: number;
  requestId?: string;
}

// ---------- tasks, reminders, commands (Phase 7) ----------

export interface SyncResult {
  tasks: import('./taskStore').ServerTask[];
  reminders: import('./taskStore').ServerReminder[];
  serverTime: string;
}

/** What SMOI understood a command to mean (backend com.smoi.command.Proposal). Nothing done yet. */
export interface Proposal {
  intent: 'create_task' | 'create_reminder' | 'ask_brain' | 'list_events' | 'create_event' | 'draft_email' | 'unknown';
  /** False for intents whose feature isn't built yet. */
  available: boolean;
  task: { title: string; dueAt: string | null; priority: 'low' | 'normal' | 'high' } | null;
  reminder: { title: string; firstAt: string; repeat: import('./recurrence').Repeat; weekdays: number } | null;
  question: string | null;
  /** A plain sentence explaining why the command can't be used as it stands. */
  problem: string | null;
}
