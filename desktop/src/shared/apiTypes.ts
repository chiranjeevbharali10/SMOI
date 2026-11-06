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

/** A watched folder with its files counted by status (GET /api/folders). */
export interface FolderInfo {
  id: string;
  path: string;
  total: number;
  done: number;
  pending: number;
  failed: number;
  needsOcr: number;
}

export interface FoldersInfo {
  folders: FolderInfo[];
  total: number;
  done: number;
  pending: number;
  failed: number;
  needsOcr: number;
  ocrEnabled: boolean;
}

/** One file of a watched folder, as the index knows it. */
export interface FolderFileInfo {
  id: string;
  folderId: string;
  path: string;
  contentHash: string | null;
  modifiedTime: string;
  sizeBytes: number;
  status: 'pending' | 'done' | 'failed' | 'needs_ocr';
  error: string | null;
  documentId: string | null;
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
  | 'not_found' | 'gone' | 'invalid' | 'conflict' | 'too_large' | 'unsupported' | 'unavailable' | 'server'
  // Google (Phase 8): from the problem's "code"
  | 'google_reconnect' | 'google_not_connected' | 'google_not_configured';

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
  intent: 'create_task' | 'create_reminder' | 'ask_brain' | 'list_events' | 'create_event' | 'update_event' | 'delete_event'
    | 'draft_email' | 'unknown';
  /** False for intents whose feature isn't built yet. */
  available: boolean;
  task: { title: string; dueAt: string | null; priority: 'low' | 'normal' | 'high' } | null;
  reminder: { title: string; firstAt: string; repeat: import('./recurrence').Repeat; weekdays: number } | null;
  question: string | null;
  /** A plain sentence explaining why the command can't be used as it stands. */
  problem: string | null;
  event?: { title: string; start: string; end: string } | null;
  /** Which event to change (words from its title, and its day), and the new start; null newStart for a delete. */
  eventChange?: { query: string; day: string; newStart: string | null; delete: boolean } | null;
  email?: { to: string; subject: string; body: string } | null;
}

// ---------- Google Calendar and Gmail (Phase 8) ----------

export interface GoogleScope {
  scope: string;
  name: string;
  why: string;
}

export interface GoogleStatus {
  status: 'not_configured' | 'not_connected' | 'connected' | 'reconnect_required';
  email: string | null;
  grantedScopes: string[];
  scopes: GoogleScope[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  /** Timed events. */
  start: string | null;
  end: string | null;
  /** All-day events (YYYY-MM-DD; end is exclusive). */
  startDate: string | null;
  endDate: string | null;
  link: string;
  reminderMinutes: number[] | null;
}

export interface Upcoming {
  events: CalendarEvent[];
  today: { busy: boolean; booked: string; longestRun: number; reason: string | null };
}

export type EmailCategory = 'recruitment' | 'academic' | 'personal' | 'important' | 'promotional';

/** All text fields are untrusted email content, shown only as plain text. */
export interface EmailItem {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  category: EmailCategory | null;
  summary: string;
  gmailLink: string;
  indexed: boolean;
  taskId: string | null;
}

export interface EmailAlert {
  id: string;
  receivedAt: string;
}

export interface SyncSummary {
  fullSync: boolean;
  newMessages: number;
  classified: number;
  unclassified: number;
}

export interface DraftItem {
  id: string;
  to: string;
  subject: string;
  body: string;
  gmailLink: string;
  gone: boolean;
}

/** A change to Google waiting for the user's confirmation (the backend's google_actions row). */
export interface GooglePreview {
  id: string;
  kind: 'create_event' | 'update_event' | 'delete_event' | 'create_draft' | 'update_draft';
  expiresAt: string;
  before: unknown;
  after: unknown;
  conflicts: CalendarEvent[];
}

export interface GoogleOutcome {
  id: string;
  kind: GooglePreview['kind'];
  status: 'applied' | 'failed' | 'proposed' | 'applying';
  result: Record<string, unknown> | null;
}

export interface ReminderCheck {
  fire: boolean;
  checked: boolean;
  message: string | null;
}
