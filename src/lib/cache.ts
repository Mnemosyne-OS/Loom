/**
 * What Loom keeps between two readings (doc 140 §13).
 *
 * The first reading in the app took 68.8 s for 3.1 GB of conversations. Almost
 * all of it is the same files as last time: a transcript that has not changed
 * size or modification time gives the same summary. So Loom keeps, per file,
 * the SUMMARY it made (dates, file names, short shas — never the text), keyed
 * by repository name and path, and checked by `size:mtime`.
 *
 * The history is kept too: commits never change, only new ones arrive. The
 * reuse rule is in `scan.ts` (`loadCommits`) and is checked against git's own
 * count, so a rewritten history is read again in full.
 *
 * 🎭 A cache is allowed to be gone. Stored in the cartridge's IndexedDB, it
 * disappears if the frame's origin changes (doc 73) or the person clears site
 * data; then Loom reads everything, as on the first run. A cache that cannot be
 * opened is never an error on screen, but the reading line says what came from
 * it, so a slow reading is never a mystery.
 */
import type { Commit, Session } from './types';
import type { StoredDigest } from './digest';

/** One file as Loom last summarised it. `session: null` = read, but undated. */
export interface CachedFile {
  fp: string;
  session: Session | null;
}

/** The per-file half, as the reading pass uses it. */
export interface FileCache {
  get(key: string): CachedFile | undefined;
  put(key: string, entry: CachedFile): void;
}

/** The history as last read, for one repository. */
export interface CachedHistory {
  commits: Commit[];
  total: number | null;
}

/** The fingerprint of a listed file, or null when the listing gave no date (then never cached). */
export function fingerprint(sizeBytes: number, mtime: number | undefined): string | null {
  return typeof mtime === 'number' && Number.isFinite(mtime) ? `${SUMMARY_VERSION}:${sizeBytes}:${Math.round(mtime)}` : null;
}

/**
 * Bumped whenever a summary gains a field: an entry written by an older Loom
 * does not match any more and its file is read again ONCE. v2 = active time,
 * v3 = the anchored commit line and the messages of git commit commands.
 */
export const SUMMARY_VERSION = 'v3';

export const fileKey = (repoName: string, path: string) => `${repoName.toLowerCase()}|${path}`;

/** A cache in memory only: what a frame without IndexedDB gets, and what tests use. */
export class MemoryFileCache implements FileCache {
  readonly entries = new Map<string, CachedFile>();
  readonly written = new Map<string, CachedFile>();
  get(key: string): CachedFile | undefined { return this.entries.get(key); }
  put(key: string, entry: CachedFile): void { this.entries.set(key, entry); this.written.set(key, entry); }
}

// ── IndexedDB ────────────────────────────────────────────────────────────────

const DB_NAME = 'loom-cache';
const DB_VERSION = 2;
const FILES = 'files';
const HISTORY = 'history';
/** v2: the summaries of a line (doc 140 §18), so a summary is paid for once. */
const DIGESTS = 'digests';
/** Rule 9: a database that never answers must not hold the reading hostage. */
const IDB_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`IDB_TIMEOUT: ${what}`)), IDB_TIMEOUT_MS);
    p.then((v) => { clearTimeout(id); resolve(v); }, (e: unknown) => { clearTimeout(id); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB_REQUEST_FAILED'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IDB_TX_FAILED'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB_TX_ABORTED'));
  });
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** The database, or null when this frame has none (tests, a locked-down browser). */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbPromise = withTimeout(new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      if (!db.objectStoreNames.contains(HISTORY)) db.createObjectStore(HISTORY);
      if (!db.objectStoreNames.contains(DIGESTS)) db.createObjectStore(DIGESTS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB_OPEN_FAILED'));
  }), 'open').catch((err: unknown) => {
    console.warn('[Loom] no cache this time, everything will be read:', err);
    dbPromise = null;
    return null;
  });
  return dbPromise;
}

/** Every cached file of one repository, loaded once before a reading. */
export async function loadFileCache(repoName: string): Promise<MemoryFileCache> {
  const cache = new MemoryFileCache();
  const db = await openDb();
  if (!db) return cache;
  try {
    const prefix = fileKey(repoName, '');
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const tx = db.transaction(FILES, 'readonly');
    const store = tx.objectStore(FILES);
    const [keys, values] = await withTimeout(Promise.all([
      request(store.getAllKeys(range)),
      request(store.getAll(range)),
    ]), 'read files');
    keys.forEach((k, i) => {
      const v = values[i] as CachedFile | undefined;
      if (typeof k === 'string' && v && typeof v.fp === 'string') cache.entries.set(k, v);
    });
  } catch (err) {
    console.warn('[Loom] the file cache could not be read, everything will be read:', err);
    cache.entries.clear();
  }
  return cache;
}

/**
 * Write what this reading summarised, and drop what no listed file uses any
 * more for this repository (a deleted transcript, a folder unticked), so the
 * cache never grows past what the last reading looked at.
 */
export async function saveFileCache(repoName: string, cache: MemoryFileCache, seen: ReadonlySet<string>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(FILES, 'readwrite');
    const store = tx.objectStore(FILES);
    for (const [k, v] of cache.written) store.put(v, k);
    const prefix = fileKey(repoName, '');
    for (const k of cache.entries.keys()) if (k.startsWith(prefix) && !seen.has(k)) store.delete(k);
    await withTimeout(done(tx), 'write files');
  } catch (err) {
    console.warn('[Loom] the file cache could not be saved; the next reading will read these files again:', err);
  }
}

/** The history kept for one repository, or null (none kept, or no database). */
export async function loadHistory(repoId: string): Promise<CachedHistory | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const v = await withTimeout(request(db.transaction(HISTORY, 'readonly').objectStore(HISTORY).get(repoId)), 'read history');
    const h = v as CachedHistory | undefined;
    return h && Array.isArray(h.commits) ? h : null;
  } catch (err) {
    console.warn('[Loom] the history cache could not be read:', err);
    return null;
  }
}

/** Keep the history of one repository; a failure only costs a full reading next time. */
export async function saveHistory(repoId: string, history: CachedHistory): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(HISTORY, 'readwrite');
    tx.objectStore(HISTORY).put(history, repoId);
    await withTimeout(done(tx), 'write history');
  } catch (err) {
    console.warn('[Loom] the history cache could not be saved:', err);
  }
}

/** The summary kept for one line of one repository, or null. */
export async function loadDigest(key: string): Promise<StoredDigest | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const v = await withTimeout(request(db.transaction(DIGESTS, 'readonly').objectStore(DIGESTS).get(key)), 'read digest');
    const d = v as StoredDigest | undefined;
    return d && typeof d.text === 'string' && typeof d.at === 'number' ? d : null;
  } catch (err) {
    console.warn('[Loom] a kept summary could not be read:', err);
    return null;
  }
}

/** Keep a summary. False when it could not be kept: the screen says the next view will not find it. */
export async function saveDigest(key: string, digest: StoredDigest): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(DIGESTS, 'readwrite');
    tx.objectStore(DIGESTS).put(digest, key);
    await withTimeout(done(tx), 'write digest');
    return true;
  } catch (err) {
    console.warn('[Loom] the summary could not be kept:', err);
    return false;
  }
}
