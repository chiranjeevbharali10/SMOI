/**
 * Folder sync in the main process: scans the watched folders, watches them for changes, and
 * reports each change to the backend. It only ever reads the user's files. It never writes,
 * moves or deletes anything on disk; "delete" here means "remove from SMOI's index".
 *
 * - Start (after sign-in): a full rescan catches everything that changed while SMOI was closed,
 *   then one recursive fs.watch per folder (Windows' native recursive watching).
 * - Changes: watcher events only mark a folder dirty. After a quiet period the dirty folders are
 *   rescanned together, so a move between two folders is seen as one move, not a delete and an add.
 * - Each pass: list the disk, fetch the index's view, plan with shared/folderSync.ts, then run the
 *   actions one at a time (indexing is background work; the backend queues it at low priority).
 * - Safety: a folder that can't be read (unplugged drive, no permission) is skipped, never planned
 *   as "everything was deleted". The same goes for unreadable subfolders and files still being written.
 * - Crash or restart: every action is idempotent, and the next start rescans, so an interrupted
 *   pass simply finishes then.
 *
 * No Electron imports, so it is tested in Node against real temporary folders
 * (test/folderWatcher.test.ts).
 */
import { createHash } from 'node:crypto';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { ApiError } from './api';
import type { FolderFileInfo, FoldersInfo } from '../shared/apiTypes';
import {
  isoTime, isSupported, planSync, type IndexedFile, type LocalFile, type SyncAction,
} from '../shared/folderSync';

/** The parts of ApiClient folder sync uses (a fake in tests). */
export interface FolderApi {
  folders(): Promise<FoldersInfo>;
  folderFiles(folderId: string): Promise<FolderFileInfo[]>;
  syncFolderFile(folderId: string, path: string, modifiedTime: string, bytes: Uint8Array): Promise<FolderFileInfo>;
  folderFileFailed(folderId: string, path: string, modifiedTime: string, sizeBytes: number, error: string): Promise<FolderFileInfo>;
  touchFolderFile(path: string, modifiedTime: string, sizeBytes: number): Promise<FolderFileInfo>;
  moveFolderFile(fromPath: string, toFolderId: string, toPath: string): Promise<FolderFileInfo>;
  deleteFolderFile(path: string): Promise<void>;
}

export interface FolderWatcherOptions {
  api: FolderApi;
  /** Called with fresh counts after each pass, and while files are still being indexed. */
  onProgress?: (progress: FoldersInfo) => void;
  log?: (message: string) => void;
  now?: () => number;
  /** Quiet time after the last watcher event before rescanning. */
  quietMs?: number;
  /** A file modified more recently than this may still be being written; it waits for the next pass. */
  settleMs?: number;
  /** After a pass that couldn't reach the backend, or skipped files, try again this much later. */
  retryMs?: number;
  /** A full rescan this often, in case the OS dropped watcher events. */
  safetyRescanMs?: number;
  /** How often to refresh the progress while files are pending. */
  progressPollMs?: number;
}

/** What one pass did, for tests and logs. */
export interface PassResult {
  actions: SyncAction[];
  failed: string[];
  deferred: string[];
  aborted: boolean;
}

/** Errors that mean "the backend or network is not ready": stop the pass and retry later. */
const TRANSIENT = new Set(['unreachable', 'timeout', 'server', 'unavailable', 'rate_limited', 'session_expired']);

interface Folder {
  id: string;
  path: string;
}

export class FolderWatcher {
  private folders: Folder[] = [];
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly dirty = new Set<string>();
  private quietTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private safetyTimer: NodeJS.Timeout | null = null;
  private progressTimer: NodeJS.Timeout | null = null;
  private running: Promise<PassResult> | null = null;
  private again = false;
  private stopped = true;
  private paused = false;
  private readonly opts: Required<Omit<FolderWatcherOptions, 'onProgress' | 'log'>> & Pick<FolderWatcherOptions, 'onProgress' | 'log'>;

  constructor(options: FolderWatcherOptions) {
    this.opts = {
      now: Date.now, quietMs: 1500, settleMs: 2000, retryMs: 30_000, safetyRescanMs: 10 * 60_000, progressPollMs: 3000,
      ...options,
    };
  }

  /** Loads the folder list, rescans everything, then watches. Safe to call again (it restarts). */
  async start(): Promise<PassResult> {
    this.stop();
    this.stopped = false;
    try {
      await this.loadFolders();
    } catch (e) {
      // Backend not up yet (SMOI often starts before it): try the whole start again later.
      this.opts.log?.(`Folder sync waiting for the backend: ${e instanceof Error ? e.message : 'error'}`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.stopped) void this.start().catch(() => undefined);
      }, this.opts.retryMs);
      return { actions: [], failed: [], deferred: [], aborted: true };
    }
    this.safetyTimer = setInterval(() => this.markDirty(this.folders.map((f) => f.id)), this.opts.safetyRescanMs);
    return this.rescan(this.folders.map((f) => f.id));
  }

  stop(): void {
    this.stopped = true;
    this.watchers.forEach((w) => w.close());
    this.watchers.clear();
    this.dirty.clear();
    for (const t of [this.quietTimer, this.retryTimer, this.progressTimer]) if (t) clearTimeout(t);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    this.quietTimer = this.retryTimer = this.progressTimer = this.safetyTimer = null;
  }

  /**
   * Pauses sending files (for example while the local LLM needs the machine). Watcher events
   * keep marking folders dirty, and resume() catches up.
   */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.markDirty(this.folders.map((f) => f.id));
  }

  /** Call after adding or removing a folder through the API. */
  async foldersChanged(): Promise<PassResult> {
    const before = new Set(this.folders.map((f) => f.id));
    await this.loadFolders();
    const added = this.folders.filter((f) => !before.has(f.id)).map((f) => f.id);
    return this.rescan(added);
  }

  /** Waits for the current pass, if any (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Scans the given folders and brings the index in line. Passes never overlap. */
  async rescan(folderIds: string[]): Promise<PassResult> {
    folderIds.forEach((id) => this.dirty.add(id));
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass().finally(() => {
      this.running = null;
    });
    const result = await this.running;
    if (this.again && !this.stopped) {
      this.again = false;
      return this.rescan([]);
    }
    return result;
  }

  // ---------- internals ----------

  private async loadFolders(): Promise<void> {
    const info = await this.opts.api.folders();
    this.folders = info.folders.map((f) => ({ id: f.id, path: f.path }));
    this.opts.onProgress?.(info);
    const ids = new Set(this.folders.map((f) => f.id));
    for (const [id, w] of this.watchers) {
      if (!ids.has(id)) {
        w.close();
        this.watchers.delete(id);
      }
    }
    for (const f of this.folders) this.watchFolder(f);
  }

  private watchFolder(folder: Folder): void {
    if (this.stopped || this.watchers.has(folder.id)) return;
    try {
      const w = watch(folder.path, { recursive: true, persistent: false }, () => this.markDirty([folder.id]));
      w.on('error', () => {
        // The folder went away (drive unplugged, folder renamed). The safety rescan watches it again.
        w.close();
        this.watchers.delete(folder.id);
      });
      this.watchers.set(folder.id, w);
    } catch {
      this.opts.log?.(`Can't watch ${folder.path} right now; it will be checked again later.`);
    }
  }

  private markDirty(folderIds: string[]): void {
    if (this.stopped) return;
    folderIds.forEach((id) => this.dirty.add(id));
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.folders.forEach((f) => this.watchFolder(f));
      void this.rescan([]);
    }, this.opts.quietMs);
  }

  private async pass(): Promise<PassResult> {
    const empty: PassResult = { actions: [], failed: [], deferred: [], aborted: false };
    if (this.paused || this.dirty.size === 0) return empty;
    const targets = this.folders.filter((f) => this.dirty.has(f.id));
    this.dirty.clear();

    const local: LocalFile[] = [];
    const indexed: IndexedFile[] = [];
    const deferred: string[] = [];
    try {
      for (const folder of targets) {
        const disk = await scanFolder(folder, this.opts.now() - this.opts.settleMs);
        if (!disk) {
          this.opts.log?.(`Skipping ${folder.path}: it can't be read right now.`);
          continue;
        }
        local.push(...disk.files);
        deferred.push(...disk.unsettled);
        const unknown = (p: string) => disk.unsettled.includes(p) || disk.unreadableDirs.some((d) => isUnder(d, p));
        for (const f of await this.opts.api.folderFiles(folder.id)) {
          if (!unknown(f.path)) indexed.push({ ...f, folderId: f.folderId });
        }
      }
    } catch (e) {
      return this.abort(targets, e, empty);
    }

    const plan = await planSync(local, indexed, sha256File);
    deferred.push(...plan.skipped);
    const failed: string[] = [];
    for (const action of plan.actions) {
      if (this.stopped) break;
      try {
        await this.run(action);
      } catch (e) {
        if (e instanceof ApiError && TRANSIENT.has(e.kind)) return this.abort(targets, e, { ...empty, actions: plan.actions });
        failed.push(pathOf(action));
        this.opts.log?.(`${pathOf(action)}: ${e instanceof Error ? e.message : 'failed'}`);
      }
    }
    if (deferred.length > 0) this.settleLater(targets);
    void this.refreshProgress();
    return { actions: plan.actions, failed, deferred, aborted: false };
  }

  private async run(action: SyncAction): Promise<void> {
    const api = this.opts.api;
    switch (action.type) {
      case 'upload': {
        let bytes: Uint8Array;
        try {
          bytes = await readFile(action.path);
        } catch (e) {
          await api.folderFileFailed(action.folderId, action.path, isoTime(action.mtimeMs), 0,
            `Could not read the file: ${e instanceof Error ? e.message : 'unknown error'}`);
          return;
        }
        try {
          await api.syncFolderFile(action.folderId, action.path, isoTime(action.mtimeMs), bytes);
        } catch (e) {
          if (e instanceof ApiError && !TRANSIENT.has(e.kind)) {
            await api.folderFileFailed(action.folderId, action.path, isoTime(action.mtimeMs), bytes.length, e.message);
            return;
          }
          throw e;
        }
        return;
      }
      case 'touch':
        await api.touchFolderFile(action.path, isoTime(action.mtimeMs), action.size);
        return;
      case 'move':
        try {
          await api.moveFolderFile(action.from, action.toFolderId, action.to);
        } catch (e) {
          // The index lost track of the old path: send the file as new instead.
          if (!(e instanceof ApiError && e.kind === 'not_found')) throw e;
          const s = await stat(action.to);
          await this.run({ type: 'upload', folderId: action.toFolderId, path: action.to, mtimeMs: s.mtimeMs });
        }
        return;
      case 'delete':
        await api.deleteFolderFile(action.path);
        return;
      case 'tooLarge':
        await api.folderFileFailed(action.folderId, action.path, isoTime(action.mtimeMs), action.size,
          `Larger than 25 MB, the most SMOI accepts`);
        return;
    }
  }

  private abort(targets: Folder[], e: unknown, result: PassResult): PassResult {
    this.opts.log?.(`Folder sync paused: ${e instanceof Error ? e.message : 'error'}. Trying again soon.`);
    this.retryLater(targets);
    return { ...result, aborted: true };
  }

  private retryLater(targets: Folder[]): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.markDirty(targets.map((f) => f.id));
    }, this.opts.retryMs);
  }

  /** Files still being written: look again once they have had time to settle. */
  private settleLater(targets: Folder[]): void {
    if (this.stopped) return;
    setTimeout(() => this.markDirty(targets.map((f) => f.id)), this.opts.settleMs + this.opts.quietMs).unref?.();
  }

  private async refreshProgress(): Promise<void> {
    if (this.stopped) return;
    try {
      const info = await this.opts.api.folders();
      this.opts.onProgress?.(info);
      if (this.progressTimer) clearTimeout(this.progressTimer);
      this.progressTimer = info.pending > 0 && !this.stopped
        ? setTimeout(() => void this.refreshProgress(), this.opts.progressPollMs)
        : null;
    } catch {
      // Progress is informational; the next pass refreshes it.
    }
  }
}

interface FolderScan {
  files: LocalFile[];
  /** Modified too recently: may still be being written. */
  unsettled: string[];
  unreadableDirs: string[];
}

/** Lists the supported files under a folder. Null if the folder itself can't be read. */
export async function scanFolder(folder: Folder, settledBefore: number): Promise<FolderScan | null> {
  try {
    if (!(await stat(folder.path)).isDirectory()) return null;
  } catch {
    return null;
  }
  const out: FolderScan = { files: [], unsettled: [], unreadableDirs: [] };
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      out.unreadableDirs.push(dir);
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow links out of the folder
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && isSupported(path)) {
        try {
          const s = await stat(path);
          if (s.mtimeMs > settledBefore) out.unsettled.push(path);
          else out.files.push({ folderId: folder.id, path, size: s.size, mtimeMs: Math.floor(s.mtimeMs) });
        } catch {
          out.unsettled.push(path); // vanished or locked between listing and stat; look again later
        }
      }
    }
  };
  await walk(folder.path);
  return out;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function isUnder(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

function pathOf(action: SyncAction): string {
  return action.type === 'move' ? action.to : action.path;
}
