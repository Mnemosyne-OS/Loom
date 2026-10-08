/**
 * The timeline itself (doc 140 §1): one line per lane, a point per commit,
 * a thin bar per conversation tied to that line's commits.
 *
 * Drawn on a canvas, and built to stay smooth on 7 000+ commits (doc 140 §13,
 * the first version stuttered on pan and zoom):
 * - everything that does not depend on the camera is computed ONCE per data
 *   change (`buildLaneData`): times, colours, the conversations of each line;
 * - a frame draws only what is on screen: the visible rows, and inside a row
 *   the commits found by binary search between the two visible instants;
 * - points of one colour are one path and one fill, not one fill each, and a
 *   point that lands on the same half-pixel as the previous one is skipped;
 * - frames are coalesced: any number of wheel or pointer events between two
 *   screen refreshes give ONE paint (requestAnimationFrame, cancelled on
 *   unmount — rule 13);
 * - the canvas is the size of the window, never of the content. With every
 *   scope expanded the content is 650 lines tall, and a canvas that size
 *   exceeds what a browser will allocate.
 *
 * Colours are read from CSS variables once per paint (rule 12), with ONE
 * `getComputedStyle` call.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildLaneData, FAMILIES, lowerBound } from '../lib/laneData';
import { isGroupHeader, isHeader, isSubHeader } from '../lib/areas';
import { SUB_SEP } from '../lib/subareas';
import { formatDuration } from '../lib/active';
import { fit, panBy, ticks, tOf, xOf, zoomAt, type View } from '../lib/view';
import type { Commit, CommitLinks, Lane, Session } from '../lib/types';
import { useI18n } from '../i18n/useI18n';

const LABEL_W = 220;
const AXIS_H = 26;
const ROW_H = 30;
const DOT_R = 3.5;
const HIT_PX = 7;

export interface TimelineProps {
  commits: readonly Commit[];
  lanes: readonly Lane[];
  laneLabel: (lane: Lane) => string;
  links: readonly CommitLinks[];
  sessions: ReadonlyMap<string, Session>;
  /** Start of the first conversation read; before it, the timeline says no conversation was read. */
  convFrom: number | null;
  selected: number | null;
  onSelect: (commit: number | null) => void;
  /** Bumped by the "whole history" button. */
  fitToken: number;
  /** A click on a line's name (not on a group header). */
  onSelectLane: (row: number) => void;
  /** The line whose card is open: highlighted. */
  focusRow: number | null;
  /** When set, the camera fits this period instead of the whole history. */
  fitTo: { from: number; to: number } | null;
  /** Milestones (doc 140 §19): a row, an instant, a kind. Drawn as diamonds over the points. */
  marks: ReadonlyArray<{ row: number; at: number; kind: 'doc' | 'memory' }>;
  markLabel: (index: number) => string;
  onSelectMark: (index: number) => void;
}

/** A label that fits, cut with an ellipsis rather than squeezed by fillText's maxWidth. */
function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid; else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** The canvas timeline: lines, points, conversation bars, milestones; pan, zoom, click. */
export function Timeline(props: TimelineProps): JSX.Element {
  const { commits, lanes, laneLabel, links, sessions, convFrom, selected, onSelect, fitToken, onSelectLane, focusRow, fitTo, marks, markLabel, onSelectMark } = props;
  const { t, lang } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [hoverMark, setHoverMark] = useState<number | null>(null);
  const [overLabel, setOverLabel] = useState(false);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  /** True once the person zoomed or panned: from then on a resize keeps their view. */
  const touched = useRef(false);
  const frame = useRef<number | null>(null);

  const laneData = useMemo(() => buildLaneData(commits, lanes, links, sessions), [commits, lanes, links, sessions]);
  /** The row of each commit, for the hover and selection rings. */
  const rowOf = useMemo(() => {
    const out = new Int32Array(commits.length).fill(-1);
    lanes.forEach((l, row) => l.commits.forEach((ci) => { out[ci] = row; }));
    return out;
  }, [commits.length, lanes]);

  /** Marks per row, in time order, as indices into `marks`. */
  const marksByRow = useMemo(() => {
    const out = new Map<number, { times: Float64Array; idx: number[] }>();
    const tmp = new Map<number, number[]>();
    marks.forEach((m, i) => { const l = tmp.get(m.row); if (l) l.push(i); else tmp.set(m.row, [i]); });
    for (const [row, list] of tmp) {
      list.sort((a, b) => marks[a]!.at - marks[b]!.at);
      out.set(row, { times: Float64Array.from(list.map((i) => marks[i]!.at)), idx: list });
    }
    return out;
  }, [marks]);

  const contentH = AXIS_H + lanes.length * ROW_H + 8;
  const maxScroll = Math.max(0, contentH - size.h);

  // Size follows the container (rule 10: the observer is disconnected).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ w: Math.floor(entry.contentRect.width), h: Math.floor(entry.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(0, size.w - LABEL_W);
  const first = commits[0]?.at ?? null;
  const last = commits[commits.length - 1]?.at ?? null;

  // Fit on new data and on the button. On a resize only while the person has
  // not zoomed or panned: a wider window must not leave an empty future on the
  // right, and must not throw away a zoom someone chose either.
  const from = fitTo?.from ?? first;
  const to = fitTo?.to ?? last;
  const fitted = useRef<{ token: number; from: number | null; to: number | null }>({ token: -1, from: null, to: null });
  useEffect(() => {
    if (from === null || to === null || plotW <= 0) return;
    const f = fitted.current;
    const fresh = f.token !== fitToken || f.from !== from || f.to !== to;
    if (fresh) touched.current = false;
    if (fresh || !touched.current) {
      fitted.current = { token: fitToken, from, to };
      setView(fit(from, to, plotW));
    }
  }, [from, to, fitToken, plotW]);

  /** The line under a point of the name column, or null (axis, header, past the end). */
  const laneAt = useCallback((py: number): number | null => {
    if (py < AXIS_H) return null;
    const row = Math.floor((py - AXIS_H + scrollTop) / ROW_H);
    const lane = lanes[row];
    // A group header (APPS…) is not clickable; an app header is: it opens the
    // app. A line without commits (agent memory) has no figures to show: its
    // card would read "0 min, 0 %" where nothing was measured.
    return lane && !isGroupHeader(lane) && lane.commits.length > 0 ? row : null;
  }, [lanes, scrollTop]);

  // Keep the scroll inside the content when lines are folded away.
  useEffect(() => {
    setScrollTop((s) => Math.min(s, maxScroll));
  }, [maxScroll]);

  const markAt = useCallback((px: number, py: number): number | null => {
    if (!view || px < LABEL_W || py < AXIS_H) return null;
    const row = Math.floor((py - AXIS_H + scrollTop) / ROW_H);
    const r = marksByRow.get(row);
    if (!r) return null;
    const x = px - LABEL_W;
    const at = lowerBound(r.times, tOf(view, x));
    let best: number | null = null;
    let bestD = HIT_PX;
    for (let k = Math.max(0, at - 6); k < Math.min(r.times.length, at + 6); k++) {
      const d = Math.abs(xOf(view, r.times[k]!) - x);
      if (d <= bestD) { bestD = d; best = r.idx[k]!; }
    }
    return best;
  }, [view, marksByRow, scrollTop]);

  const commitAt = useCallback((px: number, py: number): number | null => {
    if (!view || px < LABEL_W || py < AXIS_H) return null;
    const row = Math.floor((py - AXIS_H + scrollTop) / ROW_H);
    const d = laneData[row];
    if (!d || !d.times.length) return null;
    const x = px - LABEL_W;
    const at = lowerBound(d.times, tOf(view, x));
    let best: number | null = null;
    let bestD = HIT_PX;
    for (let k = Math.max(0, at - 8); k < Math.min(d.times.length, at + 8); k++) {
      const dist = Math.abs(xOf(view, d.times[k]!) - x);
      if (dist <= bestD) { bestD = dist; best = d.idx[k]!; }
    }
    return best;
  }, [view, laneData, scrollTop]);

  const paint = useCallback(() => {
    frame.current = null;
    const canvas = canvasRef.current;
    if (!canvas || !view || size.w <= 0 || size.h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = size.w;
    const h = Math.min(size.h, contentH);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cs = getComputedStyle(canvas);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    const col = {
      text: v('--loom-text', '#ece7e1'),
      muted: v('--loom-muted', '#948c84'),
      grid: v('--loom-grid', 'rgba(127,127,127,0.06)'),
      noConv: v('--loom-noconv', 'rgba(127,127,127,0.04)'),
      bar: v('--loom-session', 'rgba(140,170,255,0.26)'),
      select: v('--loom-select', '#f6cd5c'),
      labelBg: v('--loom-label-bg', '#1a171c'),
      fam: [v('--loom-feat', '#5fd39a'), v('--loom-fix', '#ef7272'), v('--loom-docs', '#74b4f2'), v('--loom-other', '#a49c94')],
    };
    const font = v('--font-sans', 'system-ui, sans-serif');

    const tMin = tOf(view, -DOT_R);
    const tMax = tOf(view, plotW + DOT_R);
    const firstRow = Math.max(0, Math.floor(scrollTop / ROW_H));
    const lastRow = Math.min(lanes.length - 1, Math.floor((scrollTop + h - AXIS_H) / ROW_H));
    const yOfRow = (row: number) => AXIS_H + row * ROW_H - scrollTop + ROW_H / 2;

    // Rows' backgrounds and the "no conversation read" zone.
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, AXIS_H, plotW, h - AXIS_H);
    ctx.clip();
    ctx.fillStyle = col.grid;
    for (let row = firstRow; row <= lastRow; row++) {
      if (row % 2 === 0 && !isHeader(lanes[row]!)) ctx.fillRect(LABEL_W, yOfRow(row) - ROW_H / 2, plotW, ROW_H);
    }
    if (focusRow !== null && focusRow >= firstRow && focusRow <= lastRow) {
      ctx.fillStyle = v('--loom-focus', 'rgba(140,170,255,0.12)');
      ctx.fillRect(LABEL_W, yOfRow(focusRow) - ROW_H / 2, plotW, ROW_H);
    }
    if (convFrom !== null) {
      const xc = Math.min(plotW, Math.max(0, xOf(view, convFrom)));
      if (xc > 0) { ctx.fillStyle = col.noConv; ctx.fillRect(LABEL_W, AXIS_H, xc, h - AXIS_H); }
    }

    // Grid lines.
    const tk = ticks(view, plotW);
    ctx.strokeStyle = col.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const k of tk) { const x = Math.round(LABEL_W + xOf(view, k.t)) + 0.5; ctx.moveTo(x, AXIS_H); ctx.lineTo(x, h); }
    ctx.stroke();

    // Conversation bars: one path for the whole frame.
    ctx.fillStyle = col.bar;
    ctx.beginPath();
    for (let row = firstRow; row <= lastRow; row++) {
      const b = laneData[row]!.bars;
      const y = yOfRow(row);
      for (let i = 0; i < b.length; i += 2) {
        const s = b[i]!, e = b[i + 1]!;
        if (e < tMin || s > tMax) continue;
        const x0 = LABEL_W + Math.max(0, xOf(view, s));
        const x1 = LABEL_W + Math.min(plotW, xOf(view, e));
        ctx.rect(x0, y - 7, Math.max(2, x1 - x0), 14);
      }
    }
    ctx.fill();

    // Points: one filled and one hollow path per colour. A commit with no
    // conversation is hollow — present, tied to nothing, never to the nearest.
    const filled = FAMILIES.map(() => new Path2D());
    const hollow = FAMILIES.map(() => new Path2D());
    for (let row = firstRow; row <= lastRow; row++) {
      const d = laneData[row]!;
      const y = yOfRow(row);
      let lastPx = -1, lastKey = -1;
      for (let k = lowerBound(d.times, tMin); k < d.times.length && d.times[k]! <= tMax; k++) {
        const x = LABEL_W + xOf(view, d.times[k]!);
        const px = Math.round(x * 2);
        const key = d.family[k]! * 2 + d.tied[k]!;
        if (px === lastPx && key === lastKey) continue;
        lastPx = px; lastKey = key;
        const path = d.tied[k] ? filled[d.family[k]!]! : hollow[d.family[k]!]!;
        path.moveTo(x + DOT_R, y);
        path.arc(x, y, DOT_R, 0, Math.PI * 2);
      }
    }
    ctx.lineWidth = 1.2;
    FAMILIES.forEach((_, f) => {
      ctx.fillStyle = col.fam[f]!;
      ctx.fill(filled[f]!);
      ctx.strokeStyle = col.fam[f]!;
      ctx.stroke(hollow[f]!);
    });

    // Milestones: a diamond per mark, one path per kind, over the points.
    const docPath = new Path2D();
    const memPath = new Path2D();
    const DIA = 5;
    for (let row = firstRow; row <= lastRow; row++) {
      const r = marksByRow.get(row);
      if (!r) continue;
      const y = yOfRow(row);
      let lastPx = -1;
      for (let k = lowerBound(r.times, tMin); k < r.times.length && r.times[k]! <= tMax; k++) {
        const x = LABEL_W + xOf(view, r.times[k]!);
        const px = Math.round(x);
        if (px === lastPx) continue;
        lastPx = px;
        const path = marks[r.idx[k]!]!.kind === 'doc' ? docPath : memPath;
        path.moveTo(x, y - DIA - 4);
        path.lineTo(x + DIA, y - 4);
        path.lineTo(x, y + DIA - 4);
        path.lineTo(x - DIA, y - 4);
        path.closePath();
      }
    }
    ctx.fillStyle = v('--loom-mark-doc', '#f6cd5c');
    ctx.fill(docPath);
    ctx.fillStyle = v('--loom-mark-memory', '#c79bff');
    ctx.fill(memPath);

    // Hover and selection rings.
    ctx.strokeStyle = col.select;
    ctx.lineWidth = 2;
    for (const ci of [hover, selected]) {
      if (ci === null) continue;
      const c = commits[ci];
      const row = rowOf[ci] ?? -1;
      if (!c || row < firstRow || row > lastRow) continue;
      ctx.beginPath();
      ctx.arc(LABEL_W + xOf(view, c.at), yOfRow(row), DOT_R + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (hoverMark !== null) {
      const m = marks[hoverMark];
      if (m && m.row >= firstRow && m.row <= lastRow) {
        ctx.strokeStyle = col.select;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(LABEL_W + xOf(view, m.at), yOfRow(m.row) - 4, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Label column, painted over everything on the left.
    ctx.font = `12px ${font}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = col.labelBg;
    ctx.fillRect(0, AXIS_H, LABEL_W, h - AXIS_H);
    for (let row = firstRow; row <= lastRow; row++) {
      const y = yOfRow(row);
      const lane = lanes[row]!;
      if (isSubHeader(lane)) {
        // An app split into sub-lines: its name, count and time, a rule under it.
        if (row === focusRow) {
          ctx.fillStyle = v('--loom-focus', 'rgba(140,170,255,0.12)');
          ctx.fillRect(0, y - ROW_H / 2, LABEL_W, ROW_H);
        }
        ctx.font = `600 12px ${font}`;
        ctx.fillStyle = col.text;
        ctx.textAlign = 'left';
        ctx.fillText(fitText(ctx, `▾ ${laneLabel(lane)}`, LABEL_W - 120), 14, y);
        ctx.font = `12px ${font}`;
        ctx.fillStyle = col.muted;
        ctx.textAlign = 'right';
        ctx.fillText(String(lane.commits.length), LABEL_W - 10, y);
        const sd = laneData[row]!.activeMs;
        if (sd !== null) { ctx.fillStyle = col.text; ctx.fillText(formatDuration(sd, lang), LABEL_W - 50, y); }
        ctx.strokeStyle = col.grid;
        ctx.beginPath();
        ctx.moveTo(14, Math.round(y + ROW_H / 2) - 0.5);
        ctx.lineTo(w, Math.round(y + ROW_H / 2) - 0.5);
        ctx.stroke();
        continue;
      }
      if (isHeader(lane)) {
        // A group header: its name, a rule across the plot, no count.
        ctx.font = `600 11px ${font}`;
        ctx.fillStyle = col.muted;
        ctx.textAlign = 'left';
        ctx.fillText(fitText(ctx, laneLabel(lane).toUpperCase(), LABEL_W - 80), 12, y + 4);
        const gd = laneData[row]!.activeMs;
        if (gd !== null) {
          ctx.textAlign = 'right';
          ctx.fillText(formatDuration(gd, lang), LABEL_W - 10, y + 4);
        }
        ctx.strokeStyle = col.grid;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y + ROW_H / 2) - 0.5);
        ctx.lineTo(w, Math.round(y + ROW_H / 2) - 0.5);
        ctx.stroke();
        ctx.font = `12px ${font}`;
        continue;
      }
      if (row === focusRow) {
        ctx.fillStyle = v('--loom-focus', 'rgba(140,170,255,0.12)');
        ctx.fillRect(0, y - ROW_H / 2, LABEL_W, ROW_H);
      }
      ctx.fillStyle = col.text;
      ctx.textAlign = 'left';
      // A sub-line sits indented under its app's header.
      const indent = lane.key.includes(SUB_SEP) ? 32 : 20;
      ctx.fillText(fitText(ctx, laneLabel(lane), LABEL_W - 100 - indent), indent, y);
      ctx.fillStyle = col.muted;
      ctx.textAlign = 'right';
      ctx.fillText(String(lane.commits.length || marksByRow.get(row)?.idx.length || 0), LABEL_W - 10, y);
      // Active conversation time of this line (lib/active), left of the count.
      const ad = laneData[row]!.activeMs;
      if (ad !== null) {
        ctx.fillStyle = col.text;
        ctx.fillText(formatDuration(ad, lang), LABEL_W - 50, y);
      }
    }

    // The axis stays on top while the rows scroll under it.
    ctx.fillStyle = col.labelBg;
    ctx.fillRect(0, 0, w, AXIS_H);
    ctx.font = `11px ${font}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = col.muted;
    for (const k of tk) {
      const x = LABEL_W + xOf(view, k.t);
      if (x < LABEL_W || x > w) continue;
      const d = new Date(k.t);
      const label = k.unit === 'month'
        ? d.toLocaleDateString(lang, { month: 'short', year: 'numeric' })
        : k.unit === 'day'
          ? d.toLocaleDateString(lang, { day: 'numeric', month: 'short' })
          : d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(label, x + 4, AXIS_H / 2);
    }

    // How far down the lines are, when they do not all fit.
    if (maxScroll > 0) {
      const trackH = h - AXIS_H - 8;
      const thumbH = Math.max(24, trackH * (h / contentH));
      const thumbY = AXIS_H + 4 + (trackH - thumbH) * (scrollTop / maxScroll);
      ctx.fillStyle = col.muted;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(w - 5, thumbY, 3, thumbH);
      ctx.globalAlpha = 1;
    }
  }, [view, size.w, size.h, contentH, maxScroll, plotW, scrollTop, lanes, laneData, rowOf, commits, convFrom, hover, selected, laneLabel, lang, focusRow, marks, marksByRow, hoverMark]);

  // One paint per screen refresh, whatever happened since the last one.
  useEffect(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(paint);
    return () => {
      if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    };
  }, [paint]);

  // Wheel: over the names, or with Shift, it scrolls the lines; over the plot
  // it zooms (vertical wheel, pinch) or pans (horizontal wheel). A native,
  // non-passive listener: React's onWheel is passive and cannot stop the frame
  // from scrolling.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (e.shiftKey || x < LABEL_W) {
        setScrollTop((s) => Math.min(maxScroll, Math.max(0, s + (e.deltaY || e.deltaX))));
        return;
      }
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        touched.current = true;
        setView((v) => (v ? zoomAt(v, x - LABEL_W, Math.exp(-e.deltaY * 0.0015)) : v));
      } else {
        touched.current = true;
        setView((v) => (v ? panBy(v, -e.deltaX) : v));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [maxScroll]);

  const local = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <div className="timeline" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        aria-label={t('view.hint')}
        onPointerDown={(e) => { drag.current = { x: e.clientX, moved: false }; (e.target as Element).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          if (drag.current) {
            const dx = e.clientX - drag.current.x;
            if (Math.abs(dx) > 2) drag.current.moved = true;
            if (drag.current.moved) { touched.current = true; drag.current.x = e.clientX; setView((v) => (v ? panBy(v, dx) : v)); }
            return;
          }
          const p = local(e);
          const mark = markAt(p.x, p.y);
          setHoverMark((cur) => (cur === mark ? cur : mark));
          const next = mark === null ? commitAt(p.x, p.y) : null;
          setHover((cur) => (cur === next ? cur : next));
          const label = p.x < LABEL_W && laneAt(p.y) !== null;
          setOverLabel((cur) => (cur === label ? cur : label));
        }}
        onPointerUp={(e) => {
          const wasDrag = drag.current?.moved;
          drag.current = null;
          if (wasDrag) return;
          const p = local(e);
          if (p.x < LABEL_W) {
            const row = laneAt(p.y);
            if (row !== null) onSelectLane(row);
            return;
          }
          const mark = markAt(p.x, p.y);
          if (mark !== null) { onSelectMark(mark); return; }
          onSelect(commitAt(p.x, p.y));
        }}
        onPointerLeave={() => { setHover(null); setHoverMark(null); setOverLabel(false); }}
        style={{ cursor: hover !== null || hoverMark !== null || overLabel ? 'pointer' : 'grab' }}
      />
      {hoverMark !== null && marks[hoverMark] && (
        <div className="tip" role="tooltip">{markLabel(hoverMark)}</div>
      )}
      {hover !== null && commits[hover] && (
        <div className="tip" role="tooltip">{commits[hover].subject}</div>
      )}
    </div>
  );
}
