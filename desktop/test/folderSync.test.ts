import { describe, expect, it } from 'vitest';
import {
  describeProgress, isSupported, isoTime, looksUnchanged, MAX_FILE_BYTES, planSync, type IndexedFile, type LocalFile,
} from '../src/shared/folderSync';

const T1 = Date.parse('2026-11-01T10:00:00.000Z');
const T2 = Date.parse('2026-11-02T10:00:00.000Z');

const local = (path: string, size = 100, mtimeMs = T1, folderId = 'f1'): LocalFile => ({ folderId, path, size, mtimeMs });
const indexed = (path: string, contentHash: string | null, over: Partial<IndexedFile> = {}): IndexedFile => ({
  folderId: 'f1', path, contentHash, modifiedTime: new Date(T1).toISOString(), sizeBytes: 100, status: 'done', ...over,
});
/** Hashes by a table, and records which paths were hashed. */
function hasher(table: Record<string, string>) {
  const calls: string[] = [];
  const hash = async (path: string) => {
    calls.push(path);
    if (!(path in table)) throw new Error(`EBUSY: ${path}`);
    return table[path];
  };
  return { hash, calls };
}

describe('supported files', () => {
  it('accepts PDF, DOCX and TXT in any case, and skips Office lock files', () => {
    expect(isSupported('C:\\a\\Report.PDF')).toBe(true);
    expect(isSupported('C:\\a\\notes.docx')).toBe(true);
    expect(isSupported('C:\\a\\notes.txt')).toBe(true);
    expect(isSupported('C:\\a\\sheet.xlsx')).toBe(false);
    expect(isSupported('C:\\a\\~$notes.docx')).toBe(false);
    expect(isSupported('C:\\a\\pdf')).toBe(false);
  });
});

describe('the quick check', () => {
  it('compares whole milliseconds, because NTFS times have fractions the backend does not keep', () => {
    expect(looksUnchanged(local('a.txt', 100, T1 + 0.4567), indexed('a.txt', 'h'))).toBe(true);
    expect(isoTime(T1 + 0.9)).toBe('2026-11-01T10:00:00.000Z');
    expect(looksUnchanged(local('a.txt', 101), indexed('a.txt', 'h'))).toBe(false);
    expect(looksUnchanged(local('a.txt', 100, T2), indexed('a.txt', 'h'))).toBe(false);
  });
});

describe('planSync: one file event at a time', () => {
  it('does nothing, and hashes nothing, for an unchanged file', async () => {
    const h = hasher({});
    const plan = await planSync([local('C:\\d\\a.txt')], [indexed('C:\\d\\a.txt', 'h1')], h.hash);
    expect(plan.actions).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('uploads a new file', async () => {
    const plan = await planSync([local('C:\\d\\new.pdf')], [], hasher({ 'C:\\d\\new.pdf': 'h1' }).hash);
    expect(plan.actions).toEqual([{ type: 'upload', folderId: 'f1', path: 'C:\\d\\new.pdf', mtimeMs: T1 }]);
  });

  it('only touches a file whose time changed but whose bytes did not', async () => {
    const plan = await planSync([local('C:\\d\\a.txt', 100, T2)], [indexed('C:\\d\\a.txt', 'h1')], hasher({ 'C:\\d\\a.txt': 'h1' }).hash);
    expect(plan.actions).toEqual([{ type: 'touch', path: 'C:\\d\\a.txt', mtimeMs: T2, size: 100 }]);
  });

  it('uploads an edited file (new bytes at the same path)', async () => {
    const plan = await planSync([local('C:\\d\\a.txt', 120, T2)], [indexed('C:\\d\\a.txt', 'h1')], hasher({ 'C:\\d\\a.txt': 'h2' }).hash);
    expect(plan.actions).toEqual([{ type: 'upload', folderId: 'f1', path: 'C:\\d\\a.txt', mtimeMs: T2 }]);
  });

  it('turns a rename into a move plus a touch, with no upload and no delete', async () => {
    const plan = await planSync([local('C:\\d\\new name.txt', 100, T2)], [indexed('C:\\d\\old name.txt', 'h1')],
      hasher({ 'C:\\d\\new name.txt': 'h1' }).hash);
    expect(plan.actions).toEqual([
      { type: 'move', from: 'C:\\d\\old name.txt', toFolderId: 'f1', to: 'C:\\d\\new name.txt' },
      { type: 'touch', path: 'C:\\d\\new name.txt', mtimeMs: T2, size: 100 },
    ]);
  });

  it('turns a move into another watched folder into a move', async () => {
    const plan = await planSync([local('E:\\archive\\a.txt', 100, T1, 'f2')], [indexed('C:\\d\\a.txt', 'h1')],
      hasher({ 'E:\\archive\\a.txt': 'h1' }).hash);
    expect(plan.actions[0]).toEqual({ type: 'move', from: 'C:\\d\\a.txt', toFolderId: 'f2', to: 'E:\\archive\\a.txt' });
  });

  it('deletes a file that is gone', async () => {
    const plan = await planSync([], [indexed('C:\\d\\gone.txt', 'h1')], hasher({}).hash);
    expect(plan.actions).toEqual([{ type: 'delete', path: 'C:\\d\\gone.txt' }]);
  });

  it('records a file that is too large instead of hashing or sending it', async () => {
    const h = hasher({});
    const plan = await planSync([local('C:\\d\\huge.pdf', MAX_FILE_BYTES + 1)], [], h.hash);
    expect(plan.actions).toEqual([{ type: 'tooLarge', folderId: 'f1', path: 'C:\\d\\huge.pdf', mtimeMs: T1, size: MAX_FILE_BYTES + 1 }]);
    expect(h.calls).toEqual([]);
  });

  it('skips a file it cannot hash (locked) and plans nothing for it', async () => {
    const plan = await planSync([local('C:\\d\\locked.docx', 100, T2)], [indexed('C:\\d\\locked.docx', 'h1')], hasher({}).hash);
    expect(plan).toEqual({ actions: [], skipped: ['C:\\d\\locked.docx'] });
  });

  it('does not retry a failed file until it changes, then sends it again', async () => {
    const failed = indexed('C:\\d\\bad.pdf', 'h1', { status: 'failed' });
    expect((await planSync([local('C:\\d\\bad.pdf')], [failed], hasher({}).hash)).actions).toEqual([]);
    const plan = await planSync([local('C:\\d\\bad.pdf', 100, T2)], [failed], hasher({ 'C:\\d\\bad.pdf': 'h1' }).hash);
    expect(plan.actions).toEqual([{ type: 'upload', folderId: 'f1', path: 'C:\\d\\bad.pdf', mtimeMs: T2 }]);
  });

  it('uploads a new path rather than moving a failed file there', async () => {
    const plan = await planSync([local('C:\\d\\b.pdf')], [indexed('C:\\d\\a.pdf', 'h1', { status: 'failed' })],
      hasher({ 'C:\\d\\b.pdf': 'h1' }).hash);
    expect(plan.actions.map((a) => a.type)).toEqual(['upload', 'delete']);
  });
});

describe('planSync: several changes at once (a startup rescan after SMOI was closed)', () => {
  it('handles a mix of new, edited, renamed, deleted and unchanged files', async () => {
    const plan = await planSync(
      [
        local('C:\\d\\same.txt'),
        local('C:\\d\\edited.txt', 150, T2),
        local('C:\\d\\renamed-new.txt'),
        local('C:\\d\\brand-new.txt'),
      ],
      [
        indexed('C:\\d\\same.txt', 'hs'),
        indexed('C:\\d\\edited.txt', 'he1'),
        indexed('C:\\d\\renamed-old.txt', 'hr'),
        indexed('C:\\d\\deleted.txt', 'hd'),
      ],
      hasher({ 'C:\\d\\edited.txt': 'he2', 'C:\\d\\renamed-new.txt': 'hr', 'C:\\d\\brand-new.txt': 'hn' }).hash,
    );
    expect(plan.actions.map((a) => `${a.type} ${a.type === 'move' ? `${a.from} -> ${a.to}` : a.path}`)).toEqual([
      'move C:\\d\\renamed-old.txt -> C:\\d\\renamed-new.txt',
      'touch C:\\d\\renamed-new.txt',
      'upload C:\\d\\edited.txt',
      'upload C:\\d\\brand-new.txt',
      'delete C:\\d\\deleted.txt',
    ]);
  });

  it('pairs each copy of identical files with one vanished file', async () => {
    const plan = await planSync([local('C:\\d\\x1.txt'), local('C:\\d\\x2.txt')], [indexed('C:\\d\\old.txt', 'same')],
      hasher({ 'C:\\d\\x1.txt': 'same', 'C:\\d\\x2.txt': 'same' }).hash);
    expect(plan.actions.map((a) => a.type)).toEqual(['move', 'touch', 'upload']);
  });
});

describe('progress text', () => {
  it('reads like "142 of 300 indexed, 3 failed"', () => {
    expect(describeProgress({ total: 300, done: 142, pending: 155, failed: 3, needsOcr: 0 })).toBe('142 of 300 indexed, 3 failed');
    expect(describeProgress({ total: 5, done: 4, pending: 0, failed: 0, needsOcr: 1 })).toBe('4 of 5 indexed, 1 needs OCR');
    expect(describeProgress({ total: 0, done: 0, pending: 0, failed: 0, needsOcr: 0 })).toBe('No files yet.');
  });
});
