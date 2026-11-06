/**
 * The folder watcher against real temporary folders and an in-memory fake of the backend's
 * folder API. Covers each file event end to end (disk change -> watcher -> API call), restart
 * recovery (changes made while SMOI was closed) and an interrupted pass.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/main/api';
import { FolderWatcher, scanFolder, type FolderApi } from '../src/main/folderWatcher';
import type { FolderFileInfo, FoldersInfo } from '../src/shared/apiTypes';

/** What the backend would store, keyed by path. Mirrors FolderService's rules closely enough to test against. */
class FakeFolderApi implements FolderApi {
  readonly files = new Map<string, FolderFileInfo>();
  readonly calls: string[] = [];
  /** Make the next n calls fail as if the backend were down. */
  failNext = 0;
  private seq = 0;

  constructor(public folderList: { id: string; path: string }[]) {}

  private maybeFail(name: string) {
    this.calls.push(name);
    if (this.failNext > 0) {
      this.failNext--;
      throw new ApiError('unreachable', 'backend down');
    }
  }

  async folders(): Promise<FoldersInfo> {
    const all = [...this.files.values()];
    const count = (s: string) => all.filter((f) => f.status === s).length;
    return {
      folders: this.folderList.map((f) => ({ ...f, total: 0, done: 0, pending: 0, failed: 0, needsOcr: 0 })),
      total: all.length, done: count('done'), pending: 0, failed: count('failed'), needsOcr: 0, ocrEnabled: false,
    };
  }

  async folderFiles(folderId: string) {
    this.maybeFail('list');
    return [...this.files.values()].filter((f) => f.folderId === folderId);
  }

  async syncFolderFile(folderId: string, path: string, modifiedTime: string, bytes: Uint8Array) {
    this.maybeFail(`upload ${path}`);
    const f: FolderFileInfo = {
      id: `id${this.seq++}`, folderId, path, modifiedTime, sizeBytes: bytes.length, status: 'done', error: null,
      contentHash: createHash('sha256').update(bytes).digest('hex'), documentId: `doc-${path}`,
    };
    this.files.set(path, f);
    return f;
  }

  async folderFileFailed(folderId: string, path: string, modifiedTime: string, sizeBytes: number, error: string) {
    this.maybeFail(`failed ${path}`);
    const f: FolderFileInfo = { id: `id${this.seq++}`, folderId, path, modifiedTime, sizeBytes, status: 'failed', error, contentHash: null, documentId: null };
    this.files.set(path, f);
    return f;
  }

  async touchFolderFile(path: string, modifiedTime: string, sizeBytes: number) {
    this.maybeFail(`touch ${path}`);
    const f = this.files.get(path);
    if (!f) throw new ApiError('not_found', 'missing', 404);
    Object.assign(f, { modifiedTime, sizeBytes });
    return f;
  }

  async moveFolderFile(fromPath: string, toFolderId: string, toPath: string) {
    this.maybeFail(`move ${fromPath} -> ${toPath}`);
    const f = this.files.get(fromPath);
    if (!f) throw new ApiError('not_found', 'missing', 404);
    this.files.delete(fromPath);
    Object.assign(f, { path: toPath, folderId: toFolderId });
    this.files.set(toPath, f);
    return f;
  }

  async deleteFolderFile(path: string) {
    this.maybeFail(`delete ${path}`);
    this.files.delete(path);
  }

  /** Calls other than listing, which every pass does. */
  changes() {
    return this.calls.filter((c) => c !== 'list');
  }
}

let root: string;
let docs: string;
let watcher: FolderWatcher | null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'smoi-folders-'));
  docs = join(root, 'Docs');
  await mkdir(docs);
  watcher = null;
});

afterEach(async () => {
  watcher?.stop();
  await rm(root, { recursive: true, force: true });
});

/** Writes a file with a modified time safely in the past, so it counts as settled. */
async function put(path: string, text: string, secondsAgo = 60) {
  await writeFile(path, text);
  const t = new Date(Date.now() - secondsAgo * 1000);
  await utimes(path, t, t);
}

function newWatcher(api: FolderApi) {
  watcher = new FolderWatcher({ api, quietMs: 50, settleMs: 1000, retryMs: 60_000, safetyRescanMs: 3_600_000 });
  return watcher;
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
  await watcher?.idle();
}

describe('the startup scan', () => {
  it('sends new supported files, ignores the rest, and finds files in subfolders', async () => {
    await put(join(docs, 'a.txt'), 'alpha');
    await mkdir(join(docs, 'sub'));
    await put(join(docs, 'sub', 'b.pdf'), '%PDF-1.7 beta');
    await put(join(docs, 'sheet.xlsx'), 'not indexed');
    await put(join(docs, '~$lock.docx'), 'office lock file');
    const api = new FakeFolderApi([{ id: 'f1', path: docs }]);

    await newWatcher(api).start();

    expect([...api.files.keys()].sort()).toEqual([join(docs, 'a.txt'), join(docs, 'sub', 'b.pdf')].sort());
  });

  it('catches up on changes made while SMOI was closed, without re-sending unchanged files', async () => {
    await put(join(docs, 'same.txt'), 'unchanged');
    await put(join(docs, 'edit.txt'), 'version one');
    await put(join(docs, 'old.txt'), 'renamed while closed');
    await put(join(docs, 'gone.txt'), 'deleted while closed');
    const api = new FakeFolderApi([{ id: 'f1', path: docs }]);
    await newWatcher(api).start();
    watcher!.stop();
    const renamedDoc = api.files.get(join(docs, 'old.txt'))!.documentId;

    // SMOI is closed now.
    await put(join(docs, 'edit.txt'), 'version two, longer');
    await rename(join(docs, 'old.txt'), join(docs, 'new.txt'));
    await rm(join(docs, 'gone.txt'));
    await put(join(docs, 'fresh.txt'), 'added while closed');
    api.calls.length = 0;

    await newWatcher(api).start();

    expect(api.changes().sort()).toEqual([
      `delete ${join(docs, 'gone.txt')}`,
      `move ${join(docs, 'old.txt')} -> ${join(docs, 'new.txt')}`,
      `touch ${join(docs, 'new.txt')}`,
      `upload ${join(docs, 'edit.txt')}`,
      `upload ${join(docs, 'fresh.txt')}`,
    ].sort());
    expect(api.files.get(join(docs, 'new.txt'))!.documentId).toBe(renamedDoc); // not re-indexed
  });

  it('a second start with nothing changed sends nothing', async () => {
    await put(join(docs, 'a.txt'), 'alpha');
    const api = new FakeFolderApi([{ id: 'f1', path: docs }]);
    await newWatcher(api).start();
    api.calls.length = 0;

    await newWatcher(api).start();

    expect(api.changes()).toEqual([]);
  });

  it('never treats an unreadable folder as "everything was deleted"', async () => {
    await put(join(docs, 'a.txt'), 'alpha');
    const api = new FakeFolderApi([{ id: 'f1', path: docs }]);
    await newWatcher(api).start();
    watcher!.stop();
    api.calls.length = 0;
    // The drive is unplugged: the folder is simply not there.
    api.folderList = [{ id: 'f1', path: join(root, 'Unplugged') }];
    api.files.get(join(docs, 'a.txt'))!.folderId = 'f1';

    await newWatcher(api).start();

    expect(api.changes()).toEqual([]);
    expect(api.files.size).toBe(1);
  });

  it('leaves a file that is still being written for a later pass', async () => {
    await put(join(docs, 'copying.pdf'), '%PDF half written', 0);
    const api = new FakeFolderApi([{ id: 'f1', path: docs }]);

    const result = await newWatcher(api).start();

    expect(result.deferred).toEqual([join(docs, 'copying.pdf')]);
    expect(api.changes()).toEqual([]);
  });

  it('records files larger than 25 MB as failed without reading them', async () => {
    const big = join(docs, 'big.pdf');
    await writeFile(big, Buffer.alloc(25 * 1024 * 1024 + 1));
    const t = new Date(Date.now() - 60_000);
    await utimes(big, t, t);
    const api = new FakeFolderApi([{ id: 'f1', path: docs }]);

    await newWatcher(api).start();

    expect(api.files.get(big)).toMatchObject({ status: 'failed', error: 'Larger than 25 MB, the most SMOI accepts' });
  });
});

describe('an interrupted pass (backend down, crash, restart)', () => {
  it('waits for a backend that is not up yet, then starts on its own', async () => {
    await put(join(docs, 'a.txt'), 'alpha');
    const api = new FakeFolderApi([{ id: 'f1', path: docs }]);
    let up = false;
    const realFolders = api.folders.bind(api);
    api.folders = async () => {
      if (!up) throw new ApiError('unreachable', 'not yet');
      return realFolders();
    };
    watcher = new FolderWatcher({ api, quietMs: 50, settleMs: 1000, retryMs: 100, safetyRescanMs: 3_600_000 });

    expect((await watcher.start()).aborted).toBe(true);
    up = true;
    await until(() => api.files.has(join(docs, 'a.txt')));
  });

  it('stops at the first transient error, and the next pass finishes the job without duplicates', async () => {
    for (const n of ['a', 'b', 'c']) await put(join(docs, `${n}.txt`), `file ${n}`);
    const api = new FakeFolderApi([{ id: 'f1', path: docs }]);
    const w = newWatcher(api);
    await w.start();
    api.files.clear();
    api.calls.length = 0;

    // The second upload hits a backend that just went down.
    let n = 0;
    const real = api.syncFolderFile.bind(api);
    api.syncFolderFile = async (...args) => {
      if (n++ === 1) throw new ApiError('unreachable', 'down');
      return real(...args);
    };
    const first = await w.rescan(['f1']);
    expect(first.aborted).toBe(true);
    expect(api.files.size).toBe(1);

    // Restart: a new watcher (as after an app restart) resumes from what the index has.
    w.stop();
    const second = await newWatcher(api).start();
    expect(second.aborted).toBe(false);
    expect(api.files.size).toBe(3);
    expect(second.actions.map((a) => a.type)).toEqual(['upload', 'upload']);
  });
});

describe('live changes while running', () => {
  it('sends a new file, an edit, a rename and a delete as they happen', async () => {
    const api = new FakeFolderApi([{ id: 'f1', path: docs }]);
    await newWatcher(api).start();
    const a = join(docs, 'live.txt');

    await put(a, 'created while watching', 5);
    await until(() => api.files.has(a));

    const before = api.files.get(a)!.contentHash;
    await put(a, 'edited while watching, longer now', 4);
    await until(() => api.files.get(a)!.contentHash !== before);

    const b = join(docs, 'renamed live.txt');
    const doc = api.files.get(a)!.documentId;
    await rename(a, b);
    await until(() => api.files.has(b) && !api.files.has(a));
    expect(api.files.get(b)!.documentId).toBe(doc);

    await rm(b);
    await until(() => api.files.size === 0);
  });

  it('a move between two watched folders is one move, not a delete and an upload', async () => {
    const archive = join(root, 'Archive');
    await mkdir(archive);
    await put(join(docs, 'moving.txt'), 'moving between folders');
    const api = new FakeFolderApi([{ id: 'f1', path: docs }, { id: 'f2', path: archive }]);
    await newWatcher(api).start();
    api.calls.length = 0;

    await rename(join(docs, 'moving.txt'), join(archive, 'moving.txt'));
    await until(() => api.files.has(join(archive, 'moving.txt')));

    expect(api.changes()).toEqual([
      `move ${join(docs, 'moving.txt')} -> ${join(archive, 'moving.txt')}`,
      `touch ${join(archive, 'moving.txt')}`,
    ]);
    expect(api.files.get(join(archive, 'moving.txt'))!.folderId).toBe('f2');
  });

  it('while paused, sends nothing; on resume, catches up', async () => {
    const api = new FakeFolderApi([{ id: 'f1', path: docs }]);
    const w = newWatcher(api);
    await w.start();
    w.pause();

    await put(join(docs, 'later.txt'), 'written while paused', 5);
    await new Promise((r) => setTimeout(r, 300));
    await w.idle();
    expect(api.files.size).toBe(0);

    w.resume();
    await until(() => api.files.has(join(docs, 'later.txt')));
  });
});

describe('scanFolder', () => {
  it('returns null for a folder that does not exist', async () => {
    expect(await scanFolder({ id: 'x', path: join(root, 'missing') }, Date.now())).toBeNull();
  });

  it('only reads files: the folder is unchanged after a full sync', async () => {
    await put(join(docs, 'a.txt'), 'read only');
    const api = new FakeFolderApi([{ id: 'f1', path: docs }]);
    await newWatcher(api).start();
    await api.deleteFolderFile(join(docs, 'a.txt')); // removed from the index only
    expect(await readFile(join(docs, 'a.txt'), 'utf8')).toBe('read only');
  });
});
