/**
 * Tying commits to the conversations that made them (doc 140 §4).
 *
 * Two kinds, never merged:
 * - RECORDED: the conversation printed `[branch <sha>]` (a prefix of the
 *   commit's sha), or ran `git commit` with exactly this message inside its
 *   window (a quiet commit prints no sha). A fact the transcript wrote down.
 * - INFERRED: the conversation wrote one of the commit's files (by a tool or a
 *   shell) and the commit lands inside its window. A coincidence, shown as
 *   "probably". Measured on the commits whose conversation is known: right
 *   97.6 % of the times it proposes something, silent 42 % of the time.
 *
 * 🎭 A commit with no link has NO link — never the nearest conversation.
 */
import type { Commit, CommitLinks, Session } from './types';

/** How long after a conversation's last event a commit still counts as made in
 *  it. The commit line is often the last thing a session prints. */
export const AFTER_END_MS = 10 * 60 * 1000;

export interface LinkIndex {
  /** Per commit index. */
  byCommit: CommitLinks[];
  /** Per session id, the commits it is tied to (either kind). */
  bySession: Map<string, number[]>;
}

/** Tie every commit to the conversations that made it: recorded and inferred, kept apart. */
export function linkCommits(commits: readonly Commit[], sessions: readonly Session[]): LinkIndex {
  // Short sha → sessions that printed it. Prefix lengths vary (7 to 12).
  const byShort = new Map<string, Set<string>>();
  for (const s of sessions) for (const sh of s.shas) {
    let set = byShort.get(sh);
    if (!set) { set = new Set(); byShort.set(sh, set); }
    set.add(s.id);
  }
  const lengths = [...new Set([...byShort.keys()].map((k) => k.length))];

  // Subject → sessions that ran `git commit` with that message. A record of the
  // COMMAND, held to the session's window: the same subject written in another
  // week by another conversation is not this commit.
  const bySubject = new Map<string, Session[]>();
  for (const s of sessions) for (const subj of s.commitSubjects ?? []) {
    const list = bySubject.get(subj);
    if (list) list.push(s); else bySubject.set(subj, [s]);
  }

  // Sessions sorted by start, so the time filter does not scan every session
  // for every commit.
  const ordered = [...sessions].sort((a, b) => a.start - b.start);
  const fileSets = new Map(ordered.map((s) => [s.id, new Set([...s.toolFiles, ...s.shellFiles])]));
  const maxSpan = ordered.reduce((m, s) => Math.max(m, s.end - s.start), 0) + AFTER_END_MS;

  const byCommit: CommitLinks[] = [];
  const bySession = new Map<string, number[]>();
  const tie = (sid: string, i: number) => {
    const list = bySession.get(sid);
    if (list) list.push(i); else bySession.set(sid, [i]);
  };

  commits.forEach((c, i) => {
    const recorded = new Set<string>();
    for (const L of lengths) byShort.get(c.sha.slice(0, L))?.forEach((id) => recorded.add(id));
    for (const s of bySubject.get(c.subject.trim()) ?? []) {
      if (c.at >= s.start && c.at <= s.end + AFTER_END_MS) recorded.add(s.id);
    }

    const inferred = new Set<string>();
    if (c.files.length) {
      const files = c.files.map((f) => f.toLowerCase());
      // Only sessions that started at most maxSpan before the commit can contain it.
      const lo = lowerBound(ordered, c.at - maxSpan);
      for (let k = lo; k < ordered.length; k++) {
        const s = ordered[k]!;
        if (s.start > c.at) break;
        if (c.at > s.end + AFTER_END_MS || recorded.has(s.id)) continue;
        const set = fileSets.get(s.id)!;
        if (files.some((f) => set.has(f))) inferred.add(s.id);
      }
    }
    const links = { recorded: [...recorded], inferred: [...inferred] };
    byCommit.push(links);
    links.recorded.forEach((sid) => tie(sid, i));
    links.inferred.forEach((sid) => tie(sid, i));
  });
  return { byCommit, bySession };
}

function lowerBound(sorted: readonly Session[], t: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.start < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** What the header says about coverage. Counts, never a percentage of nothing. */
export interface Coverage {
  commits: number;
  recorded: number;
  inferredOnly: number;
  none: number;
  /** Commits tied to more than one conversation (shown, never decided). */
  ambiguous: number;
}

/** How many commits (all, or the given ones) are recorded, only inferred, or untied. */
export function coverageOf(links: readonly CommitLinks[], indices?: readonly number[]): Coverage {
  const pick = indices ?? links.map((_, i) => i);
  const cov: Coverage = { commits: pick.length, recorded: 0, inferredOnly: 0, none: 0, ambiguous: 0 };
  for (const i of pick) {
    const l = links[i];
    if (!l) continue;
    if (l.recorded.length) cov.recorded++;
    else if (l.inferred.length) cov.inferredOnly++;
    else cov.none++;
    if (l.recorded.length + l.inferred.length > 1) cov.ambiguous++;
  }
  return cov;
}
