/**
 * The timeline's camera: which instant sits at which pixel (doc 140 §1).
 *
 * Pure, so zoom and pan are tested without a canvas. MnemoClio's engine counts
 * in YEARS (doc 137); a project's history runs from hours to months, so Loom
 * counts in milliseconds. Doc 140 §7.2 leaves extracting a shared engine open
 * until both have run.
 */

export interface View {
  /** The instant at x = 0 of the plot area. */
  t0: number;
  /** Milliseconds per pixel. */
  msPerPx: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Closest zoom: one pixel is 30 seconds. Farthest: one pixel is 60 days. */
export const MIN_MS_PER_PX = 30_000;
export const MAX_MS_PER_PX = 60 * DAY;

export function xOf(v: View, t: number): number {
  return (t - v.t0) / v.msPerPx;
}

export function tOf(v: View, x: number): number {
  return v.t0 + x * v.msPerPx;
}

/** The whole range in `width` pixels, with a margin on each side. */
export function fit(min: number, max: number, width: number): View {
  const span = Math.max(max - min, HOUR);
  const w = Math.max(width, 50);
  const msPerPx = clamp(span / (w * 0.94), MIN_MS_PER_PX, MAX_MS_PER_PX);
  return { t0: min - (w * 0.03) * msPerPx, msPerPx };
}

/** Zoom by `factor` (> 1 = closer) keeping the instant under `x` where it is. */
export function zoomAt(v: View, x: number, factor: number): View {
  const anchor = tOf(v, x);
  const msPerPx = clamp(v.msPerPx / factor, MIN_MS_PER_PX, MAX_MS_PER_PX);
  return { t0: anchor - x * msPerPx, msPerPx };
}

export function panBy(v: View, dx: number): View {
  return { ...v, t0: v.t0 - dx * v.msPerPx };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** The grid step for the current zoom: the smallest that keeps ticks ≥ 80 px apart. */
const STEPS: Array<{ ms: number; unit: 'hour' | 'day' | 'month' }> = [
  { ms: HOUR, unit: 'hour' }, { ms: 3 * HOUR, unit: 'hour' }, { ms: 6 * HOUR, unit: 'hour' },
  { ms: 12 * HOUR, unit: 'hour' }, { ms: DAY, unit: 'day' }, { ms: 2 * DAY, unit: 'day' },
  { ms: 7 * DAY, unit: 'day' }, { ms: 14 * DAY, unit: 'day' }, { ms: 30 * DAY, unit: 'month' },
  { ms: 91 * DAY, unit: 'month' }, { ms: 365 * DAY, unit: 'month' },
];

export interface Tick { t: number; unit: 'hour' | 'day' | 'month' }

/**
 * Ticks between `from` and `to`, on LOCAL calendar boundaries (midnight, the
 * 1st of a month): a tick at 02:00 UTC labelled as a day reads as the wrong day.
 */
export function ticks(v: View, width: number, minGapPx = 80): Tick[] {
  const step = STEPS.find((s) => s.ms / v.msPerPx >= minGapPx) ?? STEPS[STEPS.length - 1]!;
  const from = tOf(v, 0);
  const to = tOf(v, width);
  const out: Tick[] = [];
  const d = new Date(from);
  if (step.unit === 'month') {
    const months = Math.max(1, Math.round(step.ms / (30 * DAY)));
    d.setDate(1); d.setHours(0, 0, 0, 0);
    d.setMonth(d.getMonth() - (d.getMonth() % months));
    while (d.getTime() <= to && out.length < 500) {
      if (d.getTime() >= from) out.push({ t: d.getTime(), unit: 'month' });
      d.setMonth(d.getMonth() + months);
    }
  } else if (step.unit === 'day') {
    const days = Math.round(step.ms / DAY);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() <= to && out.length < 500) {
      if (d.getTime() >= from) out.push({ t: d.getTime(), unit: 'day' });
      d.setDate(d.getDate() + days);
    }
  } else {
    const hours = Math.round(step.ms / HOUR);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() - (d.getHours() % hours));
    while (d.getTime() <= to && out.length < 500) {
      if (d.getTime() >= from) out.push({ t: d.getTime(), unit: 'hour' });
      d.setHours(d.getHours() + hours);
    }
  }
  return out;
}
