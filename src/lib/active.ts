/**
 * Active time of agent conversations (doc 140 §15).
 *
 * A conversation's window (first to last event) is not time spent: a session
 * left open overnight would count twelve hours. So Loom keeps the ACTIVE
 * intervals instead: consecutive events closer than IDLE_GAP_MS are joined, a
 * longer silence ends an interval. 🎭 It is still a measure of the transcript,
 * not of a person's work, and the screen calls it "active conversation time".
 *
 * Intervals are stored flat (`[start, end, start, end, …]`, ms) and always
 * merged before being summed: two conversations running at the same time, or a
 * subagent inside its parent, never count the same minute twice.
 */

/** A silence longer than this ends an active interval. */
export const IDLE_GAP_MS = 15 * 60 * 1000;

/** Active intervals from a list of event times (any order). */
export function activeIntervals(times: number[], gap = IDLE_GAP_MS): number[] {
  if (!times.length) return [];
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  let s = sorted[0]!;
  let e = s;
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i]!;
    if (t - e <= gap) { e = t; continue; }
    out.push(s, e);
    s = t; e = t;
  }
  out.push(s, e);
  return out;
}

/** The union of several flat interval lists, merged and sorted. */
export function unionIntervals(lists: ReadonlyArray<readonly number[]>): number[] {
  const pairs: Array<[number, number]> = [];
  for (const l of lists) for (let i = 0; i + 1 < l.length; i += 2) pairs.push([l[i]!, l[i + 1]!]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [s, e] of pairs) {
    const n = out.length;
    if (n && s <= out[n - 1]!) out[n - 1] = Math.max(out[n - 1]!, e);
    else out.push(s, e);
  }
  return out;
}

/** Total length of a flat interval list. */
export function totalMs(flat: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) sum += flat[i + 1]! - flat[i]!;
  return sum;
}

/**
 * A duration as a person reads it: "25 min", "3,5 h", "412 h". 🎭 null (not
 * measured) is an em dash, never "0 min".
 */
export function formatDuration(ms: number | null, lang: string): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const min = ms / 60_000;
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  const text = h < 10
    ? h.toLocaleString(lang, { maximumFractionDigits: 1 })
    : Math.round(h).toLocaleString(lang);
  return `${text} h`;
}
