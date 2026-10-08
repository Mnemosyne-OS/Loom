/**
 * What each line of the timeline needs to be drawn, computed ONCE per data
 * change (doc 140 §13). Kept out of `Timeline.tsx`: a component file that also
 * exports functions is a file React Fast Refresh refuses to hot-swap.
 */
import { familyOf, type TypeFamily } from './lanes';
import type { Commit, CommitLinks, Lane, Session } from './types';
import { totalMs, unionIntervals } from './active';
import { isGroupHeader, isHeader } from './areas';
import { MEMORY_LANE } from './marks';

/** Colour families, in the order the painter indexes them. */
export const FAMILIES: TypeFamily[] = ['feat', 'fix', 'docs', 'other'];

/** What a row needs to be drawn, computed once per data change. */
export interface LaneData {
  /** Commit indices, in time order. */
  idx: Int32Array;
  times: Float64Array;
  family: Uint8Array;
  tied: Uint8Array;
  /** The ACTIVE intervals of the conversations tied to this line, merged: start, end pairs. */
  bars: Float64Array;
  /**
   * Active conversation time on this line: the union of those intervals, so
   * two conversations at the same minute count once. A header line holds the
   * union of its whole group. 🎭 null = no conversation was read at all (not
   * measured), never 0.
   */
  activeMs: number | null;
}

/** The drawing data of every line, computed once per data change (never per frame). */
export function buildLaneData(
  commits: readonly Commit[],
  lanes: readonly Lane[],
  links: readonly CommitLinks[],
  sessions: ReadonlyMap<string, Session>,
): LaneData[] {
  const out: LaneData[] = lanes.map((lane) => {
    const n = lane.commits.length;
    const order = [...lane.commits].sort((a, b) => commits[a]!.at - commits[b]!.at);
    const idx = Int32Array.from(order);
    const times = new Float64Array(n);
    const family = new Uint8Array(n);
    const tied = new Uint8Array(n);
    const sids = new Set<string>();
    order.forEach((ci, k) => {
      const c = commits[ci]!;
      times[k] = c.at;
      family[k] = FAMILIES.indexOf(familyOf(c.type));
      const l = links[ci];
      if (l && l.recorded.length + l.inferred.length > 0) {
        tied[k] = 1;
        l.recorded.forEach((s) => sids.add(s));
        l.inferred.forEach((s) => sids.add(s));
      }
    });
    const lists: number[][] = [];
    for (const sid of sids) {
      const s = sessions.get(sid);
      if (s) lists.push(s.active);
    }
    const merged = unionIntervals(lists);
    if (isHeader(lane)) {
      // A header draws no point and no bar; its time stays (an app header's own).
      return { idx: new Int32Array(0), times: new Float64Array(0), family: new Uint8Array(0), tied: new Uint8Array(0), bars: new Float64Array(0), activeMs: sessions.size ? totalMs(merged) : null };
    }
    return {
      idx, times, family, tied,
      bars: Float64Array.from(merged),
      activeMs: sessions.size && lane.key !== MEMORY_LANE ? totalMs(merged) : null,
    };
  });

  // A header line carries the union of the lines under it, up to the next header.
  for (let i = 0; i < lanes.length; i++) {
    if (!isGroupHeader(lanes[i]!)) continue;
    const parts: number[][] = [];
    for (let j = i + 1; j < lanes.length && !isGroupHeader(lanes[j]!); j++) parts.push([...out[j]!.bars]);
    out[i]!.activeMs = sessions.size ? totalMs(unionIntervals(parts)) : null;
  }
  return out;
}

/** Active time of every conversation tied to at least one commit: the project's total. */
export function tiedActiveMs(links: readonly CommitLinks[], sessions: ReadonlyMap<string, Session>): number | null {
  if (!sessions.size) return null;
  const sids = new Set<string>();
  for (const l of links) { l.recorded.forEach((s) => sids.add(s)); l.inferred.forEach((s) => sids.add(s)); }
  const lists: number[][] = [];
  for (const sid of sids) { const s = sessions.get(sid); if (s) lists.push(s.active); }
  return totalMs(unionIntervals(lists));
}

/** First index whose time is >= t. */
export function lowerBound(a: Float64Array, t: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m]! < t) lo = m + 1; else hi = m; }
  return lo;
}

