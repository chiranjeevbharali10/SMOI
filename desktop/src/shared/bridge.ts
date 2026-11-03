/**
 * What each window's preload script exposes to its page. Each window gets only its own small
 * API: no Node, no ipcRenderer, no file paths, no network. The main process validates every
 * message (src/main/ipc.ts).
 */
import type { ApiFailure, ChunkInfo, DocumentInfo, Me, Proposal, Providers, StreamEvent } from './apiTypes';
import type { NotificationSettings } from './notify';
import type { BubbleTone, PanelRowId } from './panelActions';
import type { Personality } from './personality';
import type { ProposalView } from './proposal';
import type { Repeat } from './recurrence';
import type { Priority, ReminderItem, TaskItem } from './taskStore';

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

/** A voice command waiting for the user's answer (FR-03.06). */
export interface PanelConfirm {
  /** What speech-to-text heard, shown so the user can spot a mishearing. */
  heard: string;
  view: ProposalView;
}

export interface PanelView {
  mood: string;
  rows: PanelRowView[];
  /** When set, the panel shows this instead of its rows. */
  confirm: PanelConfirm | null;
  reducedMotion: boolean;
  /** The current bubble line, repeated in the panel's live region while the panel has focus. */
  announce: string | null;
}

export interface PanelBridge {
  /** The panel opened: play smoi-rise and focus the first row. */
  onOpen(cb: (v: PanelView) => void): void;
  onUpdate(cb: (v: PanelView) => void): void;
  choose(row: PanelRowId): void;
  /** The answer to a confirm view: true runs the command, false drops it. */
  answer(yes: boolean): void;
  close(): void;
  measured(size: { width: number; height: number }): void;
  setHit(over: boolean): void;
  ready(): void;
}

// ---------- dashboard window ----------

// ---------- recorder window (hidden) ----------

export interface RecorderBridge {
  onStart(cb: (v: { maxMs: number }) => void): void;
  onCancel(cb: () => void): void;
  /** The microphone is on. */
  started(): void;
  done(audio: Uint8Array): void;
  nothingHeard(): void;
  /** getUserMedia failed; the DOMException name (NotAllowedError, NotFoundError ...). */
  failed(name: string): void;
  ready(): void;
}

// ---------- dashboard window ----------

export type DashboardView = 'home' | 'tasks' | 'brain' | 'chat' | 'settings';

export interface UserSettings {
  reducedMotion: boolean;
  walking: boolean;
  startOnLogin: boolean;
  sleepAfterMinutes: number;
  /** Read-only here; set in settings.json. */
  backendUrl: string;
  voiceEnabled: boolean;
  /** Electron accelerator, for example "Control+Alt+J". */
  shortcut: string;
  /** Read-only: why the shortcut couldn't be registered, or null. */
  shortcutError: string | null;
  personality: Personality;
  notifications: NotificationSettings;
}

export type SettingsPatch = Partial<Omit<UserSettings, 'backendUrl' | 'shortcutError'>>;

export interface TasksSnapshot {
  /** False while signed out: there is no copy to show. */
  ready: boolean;
  /** Open first by due date, then completed. */
  tasks: TaskItem[];
  reminders: ReminderItem[];
  /** Changes not yet on the server. */
  pending: number;
  syncedAt: string | null;
}

export interface TaskInput {
  /** Omit to create a new task. */
  id?: string;
  title: string;
  description: string;
  priority: Priority;
  category: string;
  dueAt: string | null;
  completed: boolean;
}

export interface ReminderInput {
  title: string;
  firstAt: string;
  repeat: Repeat;
  weekdays: number;
  taskId: string | null;
}

/** A typed command, interpreted: what it means, and an id to confirm it with. */
export interface CommandOutcome {
  id: string;
  proposal: Proposal;
  view: ProposalView;
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
  updateSettings(patch: SettingsPatch): Promise<UserSettings>;
  // tasks and reminders (the local copy; works offline)
  tasks(): Promise<TasksSnapshot>;
  onTasks(cb: (t: TasksSnapshot) => void): void;
  saveTask(input: TaskInput): Promise<Result<TaskItem>>;
  /** The main process asks the user to confirm first. */
  deleteTask(id: string): Promise<Result<{ deleted: boolean }>>;
  saveReminder(input: ReminderInput): Promise<Result<ReminderItem>>;
  deleteReminder(id: string): Promise<Result<{ deleted: boolean }>>;
  // commands typed in "Talk to SMOI"
  command(text: string): Promise<Result<CommandOutcome>>;
  /** Runs a command the user confirmed. Only ids from command() are accepted. */
  confirmCommand(id: string): Promise<Result<{ saved: string }>>;
  /** A question asked by voice, to be asked and shown like a typed one. */
  onVoiceQuestion(cb: (question: string) => void): void;
  onSettings(cb: (s: UserSettings) => void): void;
  onNavigate(cb: (view: DashboardView) => void): void;
  /** The page is ready for input (for the NFR-01.02 measurement). */
  ready(): void;
}
