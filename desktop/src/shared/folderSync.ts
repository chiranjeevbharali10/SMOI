/**
 * Folder sync planning: compares what is on disk with what the index knows and decides what to
 * tell the backend. Pure (no file system, no network), so every file event is unit tested
 * (test/folderSync.test.ts). The main process gathers the inputs and runs the plan
 * (src/main/folderWatcher.ts).
 *
 * The same plan serves the startup rescan (changes made while SMOI was closed) and live changes
 * (a batch of watcher events), because both come down to "here is the disk now, here is the
 * index now".
 */

/** File types folder sync indexes. Add an extension here once the backend can parse it. */
export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt'] as const;

/** The backend's upload limit. Larger files are recorded as failed instead of being sent. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function isSupported(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.slice(Math.max(lower.lastIndexOf('\\'), lower.lastIndexOf('/')) + 1);
  // Office writes "~$name.docx" lock files next to open documents; they are not documents.
  if (name.startsWith('~$')) return false;
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** A file on disk. */
export interface LocalFile {
  folderId: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** What the index knows about a file (GET /api/folders/{id}/files). */
export interface IndexedFile {
  folderId: string;
  path: string;
  contentHash: string | null;
  modifiedTime: string;
  sizeBytes: number;
  status: 'pending' | 'done' | 'failed' | 'needs_ocr';
}

export type SyncAction =
  /** New or changed content: send the bytes (the backend re-indexes). */
  | { type: 'upload'; folderId: string; path: string; mtimeMs: number }
  /** Modified time or size changed but the bytes are the same: metadata only. */
  | { type: 'touch'; path: string; mtimeMs: number; size: number }
  /** Renamed or moved: same bytes at a new path. Nothing is re-indexed. */
  | { type: 'move'; from: string; toFolderId: string; to: string }
  /** Gone from disk: remove it from the index. */
  | { type: 'delete'; path: string }
  /** Too large to send: recorded as failed so it shows in the progress counts. */
  | { type: 'tooLarge'; folderId: string; path: string; mtimeMs: number; size: number };

export type Hasher = (path: string) => Promise<string>;

/**
 * The quick check: a file whose size and modified time match the index is assumed unchanged.
 * Times are compared in whole milliseconds: NTFS keeps 100 ns steps, but the time sent to the
 * backend (an ISO string) keeps milliseconds only.
 */
export function looksUnchanged(local: LocalFile, indexed: IndexedFile): boolean {
  return local.size === indexed.sizeBytes && Math.floor(local.mtimeMs) === Date.parse(indexed.modifiedTime);
}

/** The modified time as sent to the backend, in whole milliseconds. */
export function isoTime(mtimeMs: number): string {
  return new Date(Math.floor(mtimeMs)).toISOString();
}

/**
 * Plans the actions that bring the index in line with the disk.
 *
 * @param local   every supported file currently on disk in the folders being checked
 * @param indexed every file the index has for those same folders. Leave out entries whose disk
 *                state is unknown (an unreadable subfolder, a file still being written): an
 *                entry with no file on disk is planned as a delete.
 * @param hash    SHA-256 of a file's bytes; only called for files that look changed or new
 */
export interface SyncPlan {
  actions: SyncAction[];
  /** Files that could not be hashed (locked, mid-copy). Left as they are; try again later. */
  skipped: string[];
}

export async function planSync(local: LocalFile[], indexed: IndexedFile[], hash: Hasher): Promise<SyncPlan> {
  const actions: SyncAction[] = [];
  const skipped: string[] = [];
  const byPath = new Map(indexed.map((f) => [f.path, f]));
  const onDisk = new Set(local.map((f) => f.path));
  // Index entries whose file is gone: candidates for a rename or move, else a delete.
  const vanished = indexed.filter((f) => !onDisk.has(f.path));
  const vanishedByHash = new Map<string, IndexedFile[]>();
  for (const f of vanished) {
    if (!f.contentHash) continue;
    const list = vanishedByHash.get(f.contentHash) ?? [];
    list.push(f);
    vanishedByHash.set(f.contentHash, list);
  }
  const movedAway = new Set<string>();

  for (const file of local) {
    const known = byPath.get(file.path);
    if (known && looksUnchanged(file, known)) continue;
    if (file.size > MAX_FILE_BYTES) {
      actions.push({ type: 'tooLarge', folderId: file.folderId, path: file.path, mtimeMs: file.mtimeMs, size: file.size });
      continue;
    }
    let sha: string;
    try {
      sha = await hash(file.path);
    } catch {
      skipped.push(file.path);
      continue;
    }
    if (known) {
      if (known.contentHash === sha && known.status !== 'failed') {
        actions.push({ type: 'touch', path: file.path, mtimeMs: file.mtimeMs, size: file.size });
      } else {
        actions.push({ type: 'upload', folderId: file.folderId, path: file.path, mtimeMs: file.mtimeMs });
      }
      continue;
    }
    // A new path. If a vanished file had these exact bytes, it was renamed or moved here.
    const source = vanishedByHash.get(sha)?.shift();
    if (source && source.status !== 'failed') {
      movedAway.add(source.path);
      actions.push({ type: 'move', from: source.path, toFolderId: file.folderId, to: file.path });
      // The bytes are the same, but the move keeps the old modified time; record the new one.
      actions.push({ type: 'touch', path: file.path, mtimeMs: file.mtimeMs, size: file.size });
    } else {
      actions.push({ type: 'upload', folderId: file.folderId, path: file.path, mtimeMs: file.mtimeMs });
    }
  }

  for (const f of vanished) {
    if (!movedAway.has(f.path)) actions.push({ type: 'delete', path: f.path });
  }
  // Moves first, so a file moved onto a path that also changed is handled in order; deletes last,
  // so nothing is removed from the index before its replacement is known.
  const order: Record<SyncAction['type'], number> = { move: 0, touch: 1, upload: 2, tooLarge: 3, delete: 4 };
  const sorted = actions.map((a, i) => ({ a, i }))
    .sort((x, y) => order[x.a.type] - order[y.a.type] || x.i - y.i)
    .map((x) => x.a);
  return { actions: sorted, skipped };
}

/** Progress as shown in the dashboard, for example "142 of 300 indexed, 3 failed". */
export interface FolderProgress {
  total: number;
  done: number;
  pending: number;
  failed: number;
  needsOcr: number;
}

export function describeProgress(p: FolderProgress): string {
  if (p.total === 0) return 'No files yet.';
  const parts = [`${p.done} of ${p.total} indexed`];
  if (p.failed > 0) parts.push(`${p.failed} failed`);
  if (p.needsOcr > 0) parts.push(`${p.needsOcr} need${p.needsOcr === 1 ? 's' : ''} OCR`);
  return parts.join(', ');
}
