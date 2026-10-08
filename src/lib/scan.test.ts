/** The reading pass against a simulated host bridge. */
import { describe, it, expect, vi } from 'vitest';
import { listTranscripts, loadCommits, MAX_TRANSCRIPT_BYTES, readTranscripts, type Invoke } from './scan';
import type { Commit } from './types';
import { fileKey, fingerprint, MemoryFileCache, SUMMARY_VERSION } from './cache';

const commit = (i: number): Commit => ({
  sha: String(i).padStart(40, '0'), at: 1_000 * (1000 - i), author: '', parents: 1, subject: '', type: null, scope: null, files: [],
});

function host(handlers: Record<string, (p: Record<string, unknown>) => unknown>): Invoke {
  return ((action: string, payload?: unknown) => {
    const h = handlers[action];
    if (!h) return Promise.reject(new Error(`unexpected ${action}`));
    try { return Promise.resolve(h((payload ?? {}) as Record<string, unknown>)); } catch (err) { return Promise.reject(err instanceof Error ? err : new Error(String(err))); }
  }) as Invoke;
}

describe('loadCommits', () => {
  it('pages until git says done, and returns oldest first', async () => {
    const all = Array.from({ length: 2500 }, (_, i) => commit(i));
    const pages: number[] = [];
    const invoke = host({
      'git.log': (p) => {
        const skip = p.skip as number;
        const commits = all.slice(skip, skip + (p.limit as number));
        expect(p.allBranches).toBe(true);
        return { commits, total: all.length, skip, hasMore: skip + commits.length < all.length };
      },
    });
    const res = await loadCommits(invoke, 'r', (n) => pages.push(n));
    expect(pages).toEqual([1000, 2000, 2500]);
    expect(res.cut).toBe(false);
    expect(res.commits).toHaveLength(2500);
    expect(res.commits[0]!.at).toBeLessThan(res.commits[1]!.at);
  });

  it('stops on an empty page even if hasMore lies (M39)', async () => {
    const calls = vi.fn();
    const invoke = host({ 'git.log': () => { calls(); return { commits: [], total: null, skip: 0, hasMore: true }; } });
    const res = await loadCommits(invoke, 'r', () => {});
    expect(res.commits).toEqual([]);
    expect(res.cut).toBe(false);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('lets a refusal through as an error the screen can name', async () => {
    const invoke = host({ 'git.log': () => { throw new Error('REPO_GONE'); } });
    await expect(loadCommits(invoke, 'r', () => {})).rejects.toThrow('REPO_GONE');
  });
});

describe('listTranscripts', () => {
  it('finds main transcripts and subagents, filed under their parent', async () => {
    const invoke = host({
      'dialog.readDir': (p) => {
        const d = String(p.dirPath);
        if (d === 'R/proj') return { success: true, files: [
          { name: 's1.jsonl', path: 'R/proj/s1.jsonl', isDirectory: false, sizeBytes: 10 },
          { name: 'notes.txt', path: 'R/proj/notes.txt', isDirectory: false },
          { name: 's1', path: 'R/proj/s1', isDirectory: true },
          { name: 's2', path: 'R/proj/s2', isDirectory: true },
        ] };
        if (d === 'R/proj/s1/subagents') return { success: true, files: [{ name: 'agent-a.jsonl', path: 'R/proj/s1/subagents/agent-a.jsonl', isDirectory: false, sizeBytes: 5 }] };
        return { success: false, error: 'ENOENT' };
      },
    });
    const { files, unlistable } = await listTranscripts(invoke, 'R/', ['proj', 'gone']);
    expect(files.map((f) => [f.name, f.sessionId, f.isSubagent])).toEqual([
      ['s1.jsonl', 's1', false],
      ['agent-a.jsonl', 's1', true],
    ]);
    expect(unlistable).toBe(1);
  });

  it('takes a listing whose stat failed as NO date, never a date of 0', async () => {
    const invoke = host({
      'dialog.readDir': (p) => (String(p.dirPath) === 'R/proj'
        ? { success: true, files: [
          { name: 'a.jsonl', path: 'R/proj/a.jsonl', isDirectory: false, sizeBytes: 3, mtime: 0, statFailed: true },
          { name: 'b.jsonl', path: 'R/proj/b.jsonl', isDirectory: false, sizeBytes: 3, mtime: 1234 },
        ] }
        : { success: false }),
    });
    const { files } = await listTranscripts(invoke, 'R', ['proj']);
    expect(files.find((f) => f.name === 'a.jsonl')?.mtime).toBeUndefined();
    expect(files.find((f) => f.name === 'b.jsonl')?.mtime).toBe(1234);
  });
});

describe('readTranscripts', () => {
  const ts = (m: number) => new Date(Date.UTC(2026, 9, 7, 12, m)).toISOString();
  const tx = (m: number, sha: string) => [
    JSON.stringify({ type: 'user', timestamp: ts(m), message: { content: 'x' } }),
    JSON.stringify({ type: 'user', timestamp: ts(m + 1), message: { content: [{ type: 'tool_result', content: `[main ${sha}] s` }] } }),
  ].join('\n');

  it('counts what it could not read instead of dropping it, and folds subagents (in any order)', async () => {
    const contents: Record<string, string> = { 'sub.jsonl': tx(30, 'bbbbbbb'), 'main.jsonl': tx(0, 'aaaaaaa'), 'undated.jsonl': '{}' };
    const invoke = host({
      'dialog.readFile': (p) => {
        const name = String(p.filePath);
        if (name === 'refused.jsonl') return { success: false, error: 'EXT_NOT_ALLOWED' };
        return { success: true, content: contents[name] };
      },
    });
    const progress = vi.fn();
    let clock = 0;
    const { sessions, stats } = await readTranscripts(invoke, [
      { path: 'sub.jsonl', name: 'sub.jsonl', sizeBytes: 10, sessionId: 'S', isSubagent: true },
      { path: 'main.jsonl', name: 'main.jsonl', sizeBytes: 10, sessionId: 'S', isSubagent: false },
      { path: 'refused.jsonl', name: 'refused.jsonl', sizeBytes: 10, sessionId: 'R', isSubagent: false },
      { path: 'huge.jsonl', name: 'huge.jsonl', sizeBytes: MAX_TRANSCRIPT_BYTES + 1, sessionId: 'H', isSubagent: false },
      { path: 'undated.jsonl', name: 'undated.jsonl', sizeBytes: 2, sessionId: 'U', isSubagent: false },
    ], 'repo', progress, undefined, () => (clock += 100));

    expect(stats).toMatchObject({ files: 5, read: 3, refused: 1, tooLarge: 1, undated: 1, firstError: 'EXT_NOT_ALLOWED' });
    expect(progress).toHaveBeenCalledTimes(5);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: 'S', transcript: 'main.jsonl' });
    expect(sessions[0]!.shas.sort()).toEqual(['aaaaaaa', 'bbbbbbb']);
    expect(sessions[0]!.end).toBe(Date.parse(ts(31)));
  });

  it('stops when asked, without drawing a partial pass', async () => {
    const ctrl = new AbortController();
    const invoke = host({ 'dialog.readFile': () => { ctrl.abort(); return { success: true, content: tx(0, 'aaaaaaa') }; } });
    await expect(readTranscripts(invoke, [
      { path: 'a', name: 'a.jsonl', sizeBytes: 1, sessionId: 'a', isSubagent: false },
      { path: 'b', name: 'b.jsonl', sizeBytes: 1, sessionId: 'b', isSubagent: false },
    ], 'repo', () => {}, ctrl.signal)).rejects.toThrow('aborted');
  });
});

describe('the cache', () => {
  const ts = (m: number) => new Date(Date.UTC(2026, 9, 7, 12, m)).toISOString();
  const tx = (sha: string) => [
    JSON.stringify({ type: 'user', timestamp: ts(0), message: { content: 'x' } }),
    JSON.stringify({ type: 'user', timestamp: ts(1), message: { content: [{ type: 'tool_result', content: `[main ${sha}] s` }] } }),
  ].join('\n');

  it('reads nothing again when no file changed, and gives the same conversations', async () => {
    const reads = vi.fn();
    const invoke = host({ 'dialog.readFile': (p) => { reads(p.filePath); return { success: true, content: tx('aaaaaaa') }; } });
    const files = [{ path: 'a.jsonl', name: 'a.jsonl', sizeBytes: 10, mtime: 111, sessionId: 'a', isSubagent: false }];
    const cache = new MemoryFileCache();
    const one = await readTranscripts(invoke, files, 'repo', () => {}, undefined, undefined, cache);
    const two = await readTranscripts(invoke, files, 'repo', () => {}, undefined, undefined, cache);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(two.stats).toMatchObject({ read: 0, cached: 1 });
    expect(two.sessions).toEqual(one.sessions);
    expect([...two.seen]).toEqual([fileKey('repo', 'a.jsonl')]);
  });

  it('reads a file again when its size or date changed', async () => {
    const reads = vi.fn();
    const invoke = host({ 'dialog.readFile': () => { reads(); return { success: true, content: tx('bbbbbbb') }; } });
    const cache = new MemoryFileCache();
    await readTranscripts(invoke, [{ path: 'a', name: 'a.jsonl', sizeBytes: 10, mtime: 1, sessionId: 'a', isSubagent: false }], 'repo', () => {}, undefined, undefined, cache);
    const res = await readTranscripts(invoke, [{ path: 'a', name: 'a.jsonl', sizeBytes: 12, mtime: 1, sessionId: 'a', isSubagent: false }], 'repo', () => {}, undefined, undefined, cache);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(res.stats.cached).toBe(0);
  });

  it('never caches a file whose listing gave no date (nothing could tell it changed)', async () => {
    const invoke = host({ 'dialog.readFile': () => ({ success: true, content: tx('ccccccc') }) });
    const cache = new MemoryFileCache();
    await readTranscripts(invoke, [{ path: 'a', name: 'a.jsonl', sizeBytes: 10, sessionId: 'a', isSubagent: false }], 'repo', () => {}, undefined, undefined, cache);
    expect(cache.entries.size).toBe(0);
  });

  it('keeps an undated file in the cache as undated, not as a missing file', async () => {
    const invoke = host({ 'dialog.readFile': () => ({ success: true, content: '{}' }) });
    const cache = new MemoryFileCache();
    const f = [{ path: 'u', name: 'u.jsonl', sizeBytes: 2, mtime: 5, sessionId: 'u', isSubagent: false }];
    await readTranscripts(invoke, f, 'repo', () => {}, undefined, undefined, cache);
    const res = await readTranscripts(invoke, f, 'repo', () => {}, undefined, undefined, cache);
    expect(res.stats).toMatchObject({ cached: 1, undated: 1 });
  });

  it('keys the cache by repository: the same file summarises differently for another repository', () => {
    expect(fileKey('Repo', 'p')).not.toBe(fileKey('other', 'p'));
    expect(fileKey('Repo', 'p')).toBe(fileKey('repo', 'p'));
  });

  it('fingerprints only a file with a date', () => {
    expect(fingerprint(10, 1234.4)).toBe(`${SUMMARY_VERSION}:10:1234`);
    expect(fingerprint(10, undefined)).toBeNull();
    expect(fingerprint(10, Number.NaN)).toBeNull();
  });
});

describe('loadCommits with a cached history', () => {
  const all = Array.from({ length: 2500 }, (_, i) => commit(i));
  /** git lists newest first; index 0 is the newest here. */
  const gitOver = (list: Commit[]) => host({
    'git.log': (p) => {
      const skip = p.skip as number;
      const commits = list.slice(skip, skip + (p.limit as number));
      return { commits, total: list.length, skip, hasMore: skip + commits.length < list.length };
    },
  });

  it('asks for the newest page only when nothing changed', async () => {
    const pages: number[] = [];
    const res = await loadCommits(gitOver(all), 'r', (n) => pages.push(n), undefined, { commits: all });
    expect(pages).toEqual([1000]);
    expect(res.commits).toHaveLength(2500);
    expect(res.reused).toBe(1500);
  });

  it('adds the new commits and keeps the rest', async () => {
    const newer = Array.from({ length: 3 }, (_, i) => ({ ...commit(9000 + i), at: 10_000_000 + i }));
    const res = await loadCommits(gitOver([...newer, ...all]), 'r', () => {}, undefined, { commits: all });
    expect(res.commits).toHaveLength(2503);
    expect(res.total).toBe(2503);
    expect(res.commits.at(-1)!.at).toBe(10_000_002);
  });

  it('reads EVERYTHING again when the join does not match git’s count (a rewritten history)', async () => {
    const rewritten = all.slice(0, 2400);
    const pages: number[] = [];
    const res = await loadCommits(gitOver(rewritten), 'r', (n) => pages.push(n), undefined, { commits: all });
    expect(res.commits).toHaveLength(2400);
    expect(res.reused).toBe(0);
    expect(pages.at(-1)).toBe(2400);
  });
});
