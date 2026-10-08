/**
 * Everything Loom reads, through the host bridge (doc 140 §7-§8).
 *
 * Two sources, read once per press of "Read":
 * 1. the repository's history, page by page through `git.log`;
 * 2. the conversations, through `dialog.readDir` and `dialog.readFile`.
 *
 * 🚨 This pass IS the lot 1 measurement. Lot 0 read the transcripts in node in
 * 20 s; through the bridge into an iframe, every byte crosses two IPC hops.
 * The stats below (files, bytes, elapsed) are shown on screen so the first run
 * in the app answers "can this reading stay in the cartridge?" with a number.
 *
 * The host call is injected (`Invoke`), so every refusal is testable without
 * the shell.
 */
import { mergeInto, summarise } from './sessions';
import { fileKey, fingerprint, type FileCache } from './cache';
import type { Commit, Session } from './types';

export type Invoke = <T>(action: string, payload?: unknown, timeoutMs?: number) => Promise<T>;

/** `statFailed`: the host could not stat the file and sent `mtime: 0` — that 0 is not a date. */
interface DirEntry { name: string; path: string; isDirectory: boolean; sizeBytes?: number; mtime?: number; statFailed?: boolean }

/** The modification time a listing really measured, or nothing. */
const mtimeOf = (f: DirEntry): { mtime?: number } => (f.statFailed || !f.mtime ? {} : { mtime: f.mtime });
interface DirReply { success: boolean; files?: DirEntry[]; error?: string }
interface FileReply { success: boolean; content?: string; error?: string }
interface LogReply { commits: Commit[]; total: number | null; skip: number; hasMore: boolean }

/** The host's text read refuses past this (displayHandlers, 50 MB). Not asked. */
export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
export const PAGE = 1000;
/** A safety net: 200 pages = 200 000 commits. Past it the history is cut AND said. */
const MAX_PAGES = 200;

export interface CommitLoad {
  commits: Commit[];
  /** True when MAX_PAGES stopped the reading before git said it was done. */
  cut: boolean;
  /** git's own count, or null when it could not count. */
  total: number | null;
  /** How many commits came from the cache rather than from git this time. */
  reused: number;
}

/**
 * The whole history, oldest first.
 *
 * With a cached history, only the NEWEST pages are asked for: pages are read
 * until one holds nothing new, then old and new are joined. The join is kept
 * only if it has EXACTLY git's count; anything else (a rebase, a deleted
 * branch, a count git could not give) reads the whole history again. A cache
 * may cost a full reading, never a wrong timeline.
 */
export async function loadCommits(
  invoke: Invoke,
  repoId: string,
  onPage: (read: number, total: number | null) => void,
  signal?: AbortSignal,
  cached?: { commits: readonly Commit[] } | null,
): Promise<CommitLoad> {
  const page = async (skip: number) => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return invoke<LogReply>('git.log', { repoId, limit: PAGE, skip, allBranches: true });
  };

  if (cached && cached.commits.length) {
    const known = new Set(cached.commits.map((c) => c.sha));
    const fresh: Commit[] = [];
    let total: number | null = null;
    for (let p = 0; p < MAX_PAGES; p++) {
      const res = await page(fresh.length);
      total = res.total;
      const unknown = res.commits.filter((c) => !known.has(c.sha));
      fresh.push(...res.commits);
      onPage(fresh.length, total);
      if (unknown.length === 0 || !res.hasMore || res.commits.length === 0) break;
    }
    const bySha = new Map(cached.commits.map((c) => [c.sha, c]));
    for (const c of fresh) bySha.set(c.sha, c);
    if (total !== null && bySha.size === total) {
      const commits = [...bySha.values()].sort((a, b) => a.at - b.at);
      return { commits, cut: false, total, reused: Math.max(0, commits.length - fresh.length) };
    }
    // The join does not match git's count: the history was rewritten. Read it all.
  }

  const out: Commit[] = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const res = await page(out.length);
    out.push(...res.commits);
    onPage(out.length, res.total);
    if (!res.hasMore || res.commits.length === 0) {
      return { commits: out.sort((a, b) => a.at - b.at), cut: false, total: res.total, reused: 0 };
    }
  }
  return { commits: out.sort((a, b) => a.at - b.at), cut: true, total: null, reused: 0 };
}

/**
 * What a folder the person added holds. Either a projects root (sub-folders,
 * one per project) or ONE project folder (transcripts sitting directly in it):
 * both are accepted, because "add a folder" means whichever the person has.
 */
export async function listFolders(invoke: Invoke, root: string): Promise<{ folders: string[]; hasTranscripts: boolean }> {
  const res = await invoke<DirReply>('dialog.readDir', { dirPath: root });
  if (!res?.success) throw new Error(res?.error || 'READDIR_FAILED');
  const files = res.files ?? [];
  return {
    folders: files.filter((f) => f.isDirectory).map((f) => f.name),
    hasTranscripts: files.some((f) => !f.isDirectory && f.name.endsWith('.jsonl')),
  };
}

/** One transcript to read, and the conversation it belongs to. */
export interface TranscriptFile {
  path: string;
  name: string;
  sizeBytes: number;
  /** Modification time from the listing, ms. Absent = the file is never cached. */
  mtime?: number;
  /** The conversation id: the file's own for a main transcript, its parent's for a subagent. */
  sessionId: string;
  isSubagent: boolean;
}

/** `''` names the root itself (a project folder added directly). */
function joinPath(dir: string, name: string): string {
  const base = dir.replace(/[\\/]+$/, '');
  return name ? `${base}/${name}` : base;
}

/**
 * Every transcript in the chosen folders: `<session>.jsonl` at the top, and
 * `<session>/subagents/*.jsonl` folded into their parent conversation.
 */
export async function listTranscripts(
  invoke: Invoke,
  root: string,
  folders: readonly string[],
  signal?: AbortSignal,
): Promise<{ files: TranscriptFile[]; unlistable: number }> {
  const files: TranscriptFile[] = [];
  let unlistable = 0;
  for (const folder of folders) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const dir = joinPath(root, folder);
    const res = await invoke<DirReply>('dialog.readDir', { dirPath: dir });
    if (!res?.success) { unlistable++; continue; }
    for (const f of res.files ?? []) {
      if (!f.isDirectory && f.name.endsWith('.jsonl')) {
        files.push({ path: f.path, name: f.name, sizeBytes: f.sizeBytes ?? 0, ...mtimeOf(f), sessionId: f.name.slice(0, -6), isSubagent: false });
      }
    }
    for (const d of (res.files ?? []).filter((f) => f.isDirectory)) {
      const sub = await invoke<DirReply>('dialog.readDir', { dirPath: joinPath(d.path, 'subagents') });
      // A session folder without subagents is the common case, not a failure.
      if (!sub?.success) continue;
      for (const f of sub.files ?? []) {
        if (!f.isDirectory && f.name.endsWith('.jsonl')) {
          files.push({ path: f.path, name: f.name, sizeBytes: f.sizeBytes ?? 0, ...mtimeOf(f), sessionId: d.name, isSubagent: true });
        }
      }
    }
  }
  return { files, unlistable };
}

export interface ReadStats {
  files: number;
  read: number;
  bytes: number;
  /** Larger than the host reads (50 MB). Counted, never silently dropped. */
  tooLarge: number;
  /** The host refused or the file could not be read. */
  refused: number;
  /** Read, but no dated event in it. */
  undated: number;
  /** Taken from the cache: unchanged since the last reading, not read again. */
  cached: number;
  firstError: string | null;
  elapsedMs: number;
}

/** Read every transcript and fold it into conversations. */
export async function readTranscripts(
  invoke: Invoke,
  files: readonly TranscriptFile[],
  repoName: string,
  onProgress: (stats: ReadStats) => void,
  signal?: AbortSignal,
  now: () => number = () => performance.now(),
  cache?: FileCache,
): Promise<{ sessions: Session[]; stats: ReadStats; seen: Set<string> }> {
  const t0 = now();
  const stats: ReadStats = { files: files.length, read: 0, bytes: 0, tooLarge: 0, refused: 0, undated: 0, cached: 0, firstError: null, elapsedMs: 0 };
  /** Every cache key this reading looked at, so the cache can drop the rest. */
  const seen = new Set<string>();
  const main = new Map<string, Session>();
  const orphans = new Map<string, Session[]>();
  const fold = (f: TranscriptFile, s: Session) => {
    if (!f.isSubagent) {
      const sub = orphans.get(f.sessionId) ?? [];
      main.set(f.sessionId, sub.reduce(mergeInto, { ...s, id: f.sessionId }));
      orphans.delete(f.sessionId);
    } else {
      const parent = main.get(f.sessionId);
      if (parent) main.set(f.sessionId, mergeInto(parent, s));
      else orphans.set(f.sessionId, [...(orphans.get(f.sessionId) ?? []), s]);
    }
  };

  for (const f of files) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const fp = fingerprint(f.sizeBytes, f.mtime);
    const key = fileKey(repoName, f.path);
    if (fp) seen.add(key);
    const hit = fp && cache ? cache.get(key) : undefined;
    if (hit && hit.fp === fp) {
      stats.cached++;
      if (!hit.session) stats.undated++;
      else fold(f, hit.session);
    } else if (f.sizeBytes > MAX_TRANSCRIPT_BYTES) {
      stats.tooLarge++;
    } else {
      let reply: FileReply | null = null;
      try {
        reply = await invoke<FileReply>('dialog.readFile', { filePath: f.path });
      } catch (err) {
        stats.firstError ??= err instanceof Error ? err.message : String(err);
      }
      if (!reply?.success || typeof reply.content !== 'string') {
        stats.refused++;
        stats.firstError ??= reply?.error ?? 'READ_REFUSED';
      } else {
        stats.read++;
        stats.bytes += f.sizeBytes || reply.content.length;
        const s = summarise(f.name, f.path, reply.content, f.sizeBytes, repoName);
        // Only a file whose listing gave a date is kept: without one, nothing
        // could ever tell that it changed.
        if (fp && cache) cache.put(key, { fp, session: s });
        if (!s) stats.undated++;
        else fold(f, s);
      }
    }
    stats.elapsedMs = now() - t0;
    onProgress({ ...stats });
  }
  // A subagent whose parent transcript is gone is still a conversation that
  // wrote and committed: kept under the parent's id, with its own transcript.
  for (const [id, list] of orphans) {
    const [first, ...rest] = list;
    if (first) main.set(id, rest.reduce(mergeInto, { ...first, id }));
  }
  stats.elapsedMs = now() - t0;
  return { sessions: [...main.values()], stats, seen };
}

/**
 * The memory notes kept beside the chosen conversation folders
 * (`<folder>/memory/*.md`, doc 140 §19). A listing only: no note is read here.
 * A folder without a memory folder is the common case, not a failure.
 */
export async function listMemoryNotes(
  invoke: Invoke,
  root: string,
  folders: readonly string[],
  signal?: AbortSignal,
): Promise<Array<{ path: string; name: string; mtime?: number }>> {
  const out: Array<{ path: string; name: string; mtime?: number }> = [];
  for (const folder of folders) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const res = await invoke<DirReply>('dialog.readDir', { dirPath: joinPath(joinPath(root, folder), 'memory') });
    if (!res?.success) continue;
    for (const f of res.files ?? []) {
      if (!f.isDirectory && f.name.toLowerCase().endsWith('.md')) {
        out.push({ path: f.path, name: f.name, ...mtimeOf(f) });
      }
    }
  }
  return out;
}
