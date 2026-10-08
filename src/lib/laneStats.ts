/**
 * The figures of one line (doc 140 §16): what a click on an app's name shows.
 *
 * Everything here is counted from what Loom already holds (commits, links,
 * conversations); nothing is read again. 🎭 A figure that needs conversations
 * is null when none were read, never 0.
 */
import { familyOf, type TypeFamily } from './lanes';
import { totalMs, unionIntervals } from './active';
import type { Commit, CommitLinks, Lane, Session } from './types';

const WEEK = 7 * 24 * 3_600_000;

export interface LaneConversation {
  session: Session;
  /** How many of this line's commits it is tied to. */
  commits: number;
  /** True when at least one of those ties is recorded (not only probable). */
  recorded: boolean;
  activeMs: number;
}

export interface LaneStats {
  commits: number;
  byFamily: Record<TypeFamily, number>;
  first: number | null;
  last: number | null;
  /** Commits per week from the first to the last, oldest first. */
  weeks: number[];
  /** Start of the first week bucket. */
  weeksFrom: number | null;
  recorded: number;
  inferredOnly: number;
  none: number;
  /** Union of the active time of the tied conversations; null = no conversation read. */
  activeMs: number | null;
  conversations: LaneConversation[];
  /** Files most often touched by this line's commits. */
  topFiles: Array<{ file: string; commits: number }>;
}

/** The figures of one line, counted from what Loom already holds. */
export function laneStats(
  lane: Lane,
  commits: readonly Commit[],
  links: readonly CommitLinks[],
  sessions: ReadonlyMap<string, Session>,
  topFiles = 8,
): LaneStats {
  const byFamily: Record<TypeFamily, number> = { feat: 0, fix: 0, docs: 0, other: 0 };
  let first: number | null = null;
  let last: number | null = null;
  let recorded = 0, inferredOnly = 0, none = 0;
  const conv = new Map<string, { commits: number; recorded: boolean }>();
  const files = new Map<string, number>();

  for (const ci of lane.commits) {
    const c = commits[ci];
    if (!c) continue;
    byFamily[familyOf(c.type)]++;
    if (first === null || c.at < first) first = c.at;
    if (last === null || c.at > last) last = c.at;
    const l = links[ci];
    if (l?.recorded.length) recorded++;
    else if (l?.inferred.length) inferredOnly++;
    else none++;
    for (const sid of l?.recorded ?? []) {
      const e = conv.get(sid) ?? { commits: 0, recorded: false };
      e.commits++; e.recorded = true; conv.set(sid, e);
    }
    for (const sid of l?.inferred ?? []) {
      const e = conv.get(sid) ?? { commits: 0, recorded: false };
      e.commits++; conv.set(sid, e);
    }
    for (const f of new Set(c.files)) files.set(f, (files.get(f) ?? 0) + 1);
  }

  const weeks: number[] = [];
  if (first !== null && last !== null) {
    const n = Math.floor((last - first) / WEEK) + 1;
    for (let i = 0; i < n; i++) weeks.push(0);
    for (const ci of lane.commits) {
      const c = commits[ci];
      if (c) weeks[Math.floor((c.at - first) / WEEK)]!++;
    }
  }

  const conversations: LaneConversation[] = [];
  for (const [sid, e] of conv) {
    const s = sessions.get(sid);
    if (s) conversations.push({ session: s, commits: e.commits, recorded: e.recorded, activeMs: totalMs(s.active) });
  }
  conversations.sort((a, b) => b.activeMs - a.activeMs || b.commits - a.commits || a.session.id.localeCompare(b.session.id));

  return {
    commits: lane.commits.length,
    byFamily, first, last, weeks, weeksFrom: first,
    recorded, inferredOnly, none,
    activeMs: sessions.size ? totalMs(unionIntervals(conversations.map((c) => c.session.active))) : null,
    conversations,
    topFiles: [...files.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topFiles)
      .map(([file, n]) => ({ file, commits: n })),
  };
}
