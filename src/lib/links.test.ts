import { describe, it, expect } from 'vitest';
import { AFTER_END_MS, coverageOf, linkCommits } from './links';
import type { Commit, Session } from './types';

const H = 3_600_000;
const commit = (sha: string, at: number, files: string[] = []): Commit => ({
  sha: sha.padEnd(40, '0'), at, author: 'a', parents: 1, subject: 's', type: 'feat', scope: 'x', files,
});
const session = (id: string, start: number, end: number, over: Partial<Session> = {}): Session => ({
  id, transcript: `/t/${id}.jsonl`, title: id, start, end, active: [start, end], toolFiles: [], shellFiles: [], shas: [], commitSubjects: [], ...over,
});

describe('linkCommits', () => {
  it('records a link when the conversation printed a prefix of the sha', () => {
    const { byCommit, bySession } = linkCommits(
      [commit('abc1234def', 10 * H)],
      [session('s1', 0, 1 * H, { shas: ['abc1234'] })],
    );
    expect(byCommit[0]).toEqual({ recorded: ['s1'], inferred: [] });
    expect(bySession.get('s1')).toEqual([0]);
  });

  it('records a QUIET commit by the message of its git commit command, inside the window only', () => {
    const c = { ...commit('a', 2 * H), subject: 'feat(x): quiet' };
    const s = session('s', H, 3 * H, { commitSubjects: ['feat(x): quiet'] });
    expect(linkCommits([c], [s]).byCommit[0]).toEqual({ recorded: ['s'], inferred: [] });
    const later = { ...c, at: 3 * H + AFTER_END_MS + 1 };
    expect(linkCommits([later], [s]).byCommit[0]?.recorded).toEqual([]);
  });

  it('a recorded link ignores time: the sha is the proof', () => {
    const { byCommit } = linkCommits([commit('abc1234', 100 * H)], [session('s1', 0, H, { shas: ['abc1234'] })]);
    expect(byCommit[0]?.recorded).toEqual(['s1']);
  });

  it('infers from a shared file inside the window, by tool or by shell', () => {
    const { byCommit } = linkCommits(
      [commit('a1', 2 * H, ['src/a.ts']), commit('b1', 2 * H, ['docs/b.md'])],
      [session('tool', H, 3 * H, { toolFiles: ['src/a.ts'] }), session('shell', H, 3 * H, { shellFiles: ['docs/b.md'] })],
    );
    expect(byCommit[0]).toEqual({ recorded: [], inferred: ['tool'] });
    expect(byCommit[1]).toEqual({ recorded: [], inferred: ['shell'] });
  });

  it('matches file paths whatever their case in the commit', () => {
    const { byCommit } = linkCommits([commit('a1', 2 * H, ['Src/A.ts'])], [session('s', H, 3 * H, { toolFiles: ['src/a.ts'] })]);
    expect(byCommit[0]?.inferred).toEqual(['s']);
  });

  it('accepts a commit up to AFTER_END_MS after the last event, not later', () => {
    const s = session('s', 0, H, { toolFiles: ['f'] });
    expect(linkCommits([commit('a', H + AFTER_END_MS, ['f'])], [s]).byCommit[0]?.inferred).toEqual(['s']);
    expect(linkCommits([commit('a', H + AFTER_END_MS + 1, ['f'])], [s]).byCommit[0]?.inferred).toEqual([]);
    expect(linkCommits([commit('a', -1, ['f'])], [s]).byCommit[0]?.inferred).toEqual([]);
  });

  it('keeps a late commit out of a SHORT session even with a long one alongside (M09)', () => {
    // With one session, the prefilter built on the longest span happens to hold
    // the +10 min bound too; with a long session next to it, only the explicit
    // check does.
    const short = session('short', 0, H, { toolFiles: ['f'] });
    const long = session('long', 0, 60 * H, { toolFiles: ['other'] });
    expect(linkCommits([commit('a', H + AFTER_END_MS + 1, ['f'])], [short, long]).byCommit[0]?.inferred).toEqual([]);
  });

  it('never ties a commit to the NEAREST conversation when nothing matches', () => {
    const { byCommit } = linkCommits([commit('a', 2 * H, ['other.ts'])], [session('s', H, 3 * H, { toolFiles: ['f'] })]);
    expect(byCommit[0]).toEqual({ recorded: [], inferred: [] });
  });

  it('keeps a recorded session out of the inferred list, and keeps the other candidates', () => {
    const { byCommit } = linkCommits(
      [commit('abc1234', 2 * H, ['f'])],
      [session('rec', H, 3 * H, { shas: ['abc1234'], toolFiles: ['f'] }), session('other', H, 3 * H, { toolFiles: ['f'] })],
    );
    expect(byCommit[0]).toEqual({ recorded: ['rec'], inferred: ['other'] });
  });

  it('finds a long session that started long before the commit', () => {
    const { byCommit } = linkCommits(
      [commit('a', 50 * H, ['f'])],
      [session('short', 49 * H, 49.5 * H), session('long', 0, 60 * H, { toolFiles: ['f'] })],
    );
    expect(byCommit[0]?.inferred).toEqual(['long']);
  });
});

describe('coverageOf', () => {
  it('counts each commit once, recorded before inferred, and the ambiguous apart', () => {
    const links = [
      { recorded: ['a'], inferred: ['b'] },
      { recorded: [], inferred: ['c'] },
      { recorded: [], inferred: [] },
    ];
    expect(coverageOf(links)).toEqual({ commits: 3, recorded: 1, inferredOnly: 1, none: 1, ambiguous: 1 });
    expect(coverageOf(links, [2])).toEqual({ commits: 1, recorded: 0, inferredOnly: 0, none: 1, ambiguous: 0 });
  });
});
