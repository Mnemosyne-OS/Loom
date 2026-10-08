/**
 * The lines of the timeline (doc 140 §3, §10).
 *
 * One line per commit scope is unreadable: this repository has 653 of them and
 * needs 35 to cover half its commits. So the busiest N get a line each and the
 * rest are folded into one "others" line, which the person can unfold.
 *
 * ⚠️ Ranked on the WHOLE loaded history, not on the visible range. Doc 140 §10
 * said "the visible period"; ranking on it would reorder the lines on every
 * pan, and a line that moves under the pointer is a line nobody can follow.
 */
import { NO_SCOPE_LANE, OTHERS_LANE, type Commit, type Lane } from './types';

export const DEFAULT_LANES = 15;

/** The lane key of one commit: its scope, or a marker for "conventional, no scope"
 *  and for "not conventional at all" (both drawn as "no scope"). */
export function laneKeyOf(c: Commit): string {
  return c.scope ? c.scope : NO_SCOPE_LANE;
}

/**
 * Busiest scopes first (ties broken by name, so the order never depends on
 * the order commits arrived in), then one "others" line if anything is left.
 * `expanded` puts every scope on its own line.
 */
export function buildLanes(commits: readonly Commit[], top = DEFAULT_LANES, expanded = false): Lane[] {
  const groups = new Map<string, number[]>();
  commits.forEach((c, i) => {
    const k = laneKeyOf(c);
    const list = groups.get(k);
    if (list) list.push(i); else groups.set(k, [i]);
  });
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (expanded || ranked.length <= top + 1) return ranked.map(([key, idx]) => ({ key, commits: idx }));
  const lanes: Lane[] = ranked.slice(0, top).map(([key, idx]) => ({ key, commits: idx }));
  const rest = ranked.slice(top).flatMap(([, idx]) => idx).sort((a, b) => a - b);
  lanes.push({ key: OTHERS_LANE, commits: rest });
  return lanes;
}

/** How many scopes the "others" line folds together. */
export function foldedScopes(commits: readonly Commit[], lanes: readonly Lane[]): number {
  const shown = new Set(lanes.filter((l) => l.key !== OTHERS_LANE).map((l) => l.key));
  return new Set(commits.map(laneKeyOf).filter((k) => !shown.has(k))).size;
}

/** The colour family of a commit type. Unknown types share one. */
export type TypeFamily = 'feat' | 'fix' | 'docs' | 'other';

export function familyOf(type: string | null): TypeFamily {
  if (type === 'feat') return 'feat';
  if (type === 'fix' || type === 'hotfix') return 'fix';
  if (type === 'docs') return 'docs';
  return 'other';
}
