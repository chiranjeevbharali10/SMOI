/**
 * What each window's preload script exposes to its page. Each window gets only its own small
 * API: no Node, no ipcRenderer, no file paths, no network. The main process validates every
 * message (src/main/ipc.ts).
 */
import type { ApiFailure, ChunkInfo, DocumentInfo, Me, Providers, StreamEvent } from './apiTypes';
import type { BubbleTone, PanelRowId } from './panelActions';

export interface SessionStatus {
  signedIn: boolean;
  email: string | null;
  expiresAt: string | null;
  /** False when the token lives only in memory, so the next launch asks to sign in again. */
  persisted: boolean;
}

/** A request's outcome, as plain data: errors keep their kind and message across IPC. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiFailure };

// ---------- bubble window ----------

export interface BubbleShow {
  id: number;
  tone: BubbleTone;
  text: string;
  reducedMotion: boolean;
}

export interface BubblePlaced {
  id: number;
  tailX: number;
  tail: 'down' | 'up';
}

export interface BubbleBridge {
  onShow(cb: (b: BubbleShow) => void): void;
  onPlaced(cb: (p: BubblePlaced) => void): void;
  onHide(cb: () => void): void;
  measured(id: number, size: { width: number; height: number }): void;
  dismiss(id: number): void;
  setHit(over: boolean): void;
  ready(): void;
}

// ---------- panel window ----------

export interface PanelRowView {
  id: PanelRowId;
  label: string;
  available: boolean;
}

export interface PanelView {
  mood: string;
  rows: PanelRowView[];
  reducedMotion: boolean;
  /** The current bubble line, repeated in the panel's live region while the panel has focus. */
  announce: string | null;
}

export interface PanelBridge {
  /** The panel opened: play smoi-rise and focus the first row. */
  onOpen(cb: (v: PanelView) => void): void;
  onUpdate(cb: (v: PanelView) => void): void;
  choose(row: PanelRowId): void;
  close(): void;
  measured(size: { width: number; height: number }): void;
  setHit(over: boolean): void;
  ready(): void;
}

// ---------- dashboard window ----------

export type DashboardView = 'home' | 'brain' | 'chat' | 'settings';

export interface UserSettings {
  reducedMotion: boolean;
  walking: boolean;
  startOnLogin: boolean;
  sleepAfterMinutes: number;
  /** Read-only here; set in settings.json. */
  backendUrl: string;
}

export interface BackendStatus {
  reachable: boolean;
  url: string;
}

export interface DashboardBridge {
  // session
  session(): Promise<SessionStatus>;
  signIn(email: string, password: string): Promise<Result<SessionStatus>>;
  register(email: string, password: string): Promise<Result<SessionStatus>>;
  signOut(): Promise<SessionStatus>;
  onSession(cb: (s: SessionStatus) => void): void;
  me(): Promise<Result<Me>>;
  // documents
  documents(): Promise<Result<DocumentInfo[]>>;
  onDocuments(cb: (docs: DocumentInfo[]) => void): void;
  /** The main process opens the file picker and uploads what the user chose. */
  upload(): Promise<Result<{ uploaded: DocumentInfo[]; cancelled: boolean }>>;
  /** The main process asks the user to confirm before deleting. */
  deleteDocument(id: string): Promise<Result<{ deleted: boolean }>>;
  chunks(documentId: string): Promise<Result<ChunkInfo[]>>;
  // answers
  ask(question: string): Promise<Result<{ requestId: string }>>;
  onAnswer(cb: (m: { requestId: string; event: StreamEvent }) => void): void;
  // status and settings
  providers(): Promise<Result<Providers>>;
  backend(): Promise<BackendStatus>;
  onBackend(cb: (s: BackendStatus) => void): void;
  settings(): Promise<UserSettings>;
  updateSettings(patch: Partial<Omit<UserSettings, 'backendUrl'>>): Promise<UserSettings>;
  onSettings(cb: (s: UserSettings) => void): void;
  onNavigate(cb: (view: DashboardView) => void): void;
  /** The page is ready for input (for the NFR-01.02 measurement). */
  ready(): void;
}
