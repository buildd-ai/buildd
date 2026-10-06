/**
 * Geometry for the Insights flow chart: pure, so it is tested without a DOM.
 *
 * In-flight stages form one continuous cool band; needs input and released
 * sit above it; lost work is its own strip under the chart. Running is one
 * band: the role split lives in the tooltip and the legend list, because
 * splitting a band into same-hue shades fails the colour checks.
 */
import type { FlowBucket, FlowSeries, FlowTask } from '@/lib/insights-flow';

export type BandKey = 'running' | 'waiting' | 'review' | 'merged' | 'released' | 'lost';

/** Stack order, bottom to top above the axis. */
export const STACK: readonly Exclude<BandKey, 'lost'>[] = ['running', 'review', 'merged', 'waiting', 'released'];

export const BAND_LABEL: Record<BandKey, string> = {
  running: 'Agents running',
  waiting: 'Needs input',
  review: 'In review / CI',
  merged: 'Merged, not released',
  released: 'Released',
  lost: 'Failed or abandoned',
};

/** One-line meaning, shown in the legend. */
export const BAND_HINT: Record<BandKey, string> = {
  running: 'average tasks with an agent working',
  waiting: 'agents parked on a question for a person',
  review: 'PR open: CI, review or conflicts',
  merged: 'merged, waiting for a release',
  released: 'reached production since the window start',
  lost: 'failed, or PR closed without merging',
};

export function bandValue(b: FlowBucket, key: BandKey): number {
  if (key === 'running') return Object.values(b.running).reduce((s, v) => s + v, 0);
  return b[key];
}

export interface ChartGeometry {
  width: number;
  height: number;
  /** Plot box inside the margins. */
  plot: { left: number; right: number; top: number; bottom: number };
  /** y of the zero axis of the main chart. */
  zeroY: number;
  /**
   * Top edge of the lost-work strip under the main chart (= plot.bottom when
   * nothing was lost). The strip is its own small chart with its own scale,
   * separated from the main one by STRIP_GAP, so its numbers never share an axis
   * with the stages above.
   */
  lostTop: number;
  /** Max stacked value above the axis and max lost below it (both >= 1). */
  maxUp: number;
  maxDown: number;
  /** SVG path per band (closed polygon). */
  paths: Record<BandKey, string>;
  /** Top edge per band, for the 2px separator. */
  edges: Record<BandKey, string>;
  /** Main chart ticks, 0..maxUp. */
  yTicks: { value: number; y: number }[];
  /** Strip ticks, 0 at its top and maxDown at its bottom; empty when too short to label. */
  lostTicks: { value: number; y: number }[];
  xTicks: { at: number; x: number; label: string }[];
  releases: { at: number; x: number; version: string | null; shipped: boolean; state: string }[];
  xOf: (t: number) => number;
  bucketIndexAt: (x: number) => number;
}

export const MIN_DOWN_SHARE = 0.15;
export const MAX_DOWN_SHARE = 0.35;
/** Closer than this, two tick labels collide. */
const TICK_GAP = 14;
/** Space between the main chart and the lost-work strip: a small visual separation. */
export const STRIP_GAP = 8;

/** Round up to a clean axis maximum on a fine ladder (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 per decade), so a stack never fills only half the height. */
export function niceCeil(v: number): number {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function fmtTick(at: number, spanMs: number): string {
  const d = new Date(at);
  if (spanMs <= 8 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function buildGeometry(series: FlowSeries, width: number, height: number): ChartGeometry {
  const plot = { left: 32, right: width - 8, top: 8, bottom: height - 22 };
  const buckets = series.buckets;
  const stackTotals = buckets.map(b => STACK.reduce((s, k) => s + bandValue(b, k), 0));
  const maxUp = niceCeil(Math.max(1, ...stackTotals));
  const maxLost = Math.max(0, ...buckets.map(b => b.lost));
  const maxDown = maxLost > 0 ? niceCeil(maxLost) : 0;
  // Lost work gets its own strip under the chart, 15-35% of the height: enough
  // to read when there is a little, never enough to flatten the work above.
  const plotH = plot.bottom - plot.top;
  const downShare = maxDown > 0 ? Math.min(MAX_DOWN_SHARE, Math.max(MIN_DOWN_SHARE, maxDown / (maxUp + maxDown))) : 0;
  const lostTop = plot.bottom - plotH * downShare;
  const zeroY = maxDown > 0 ? lostTop - STRIP_GAP : plot.bottom;
  const unit = (zeroY - plot.top) / maxUp;

  const { from, to } = series.window;
  const xOf = (t: number) => plot.left + ((t - from) / Math.max(1, to - from)) * (plot.right - plot.left);
  // Each bucket is drawn at its midpoint; the first and last extend to the plot edges.
  const xs = buckets.map((b, i) =>
    i === 0 ? plot.left : i === buckets.length - 1 ? plot.right : xOf((b.start + b.end) / 2));

  const paths = {} as Record<BandKey, string>;
  const edges = {} as Record<BandKey, string>;
  const base = buckets.map(() => 0);
  for (const key of STACK) {
    const lower = base.slice();
    const upper = buckets.map((b, i) => (base[i] += bandValue(b, key)));
    const top = upper.map((v, i) => `${xs[i].toFixed(1)},${(zeroY - v * unit).toFixed(1)}`);
    const bottom = lower.map((v, i) => `${xs[i].toFixed(1)},${(zeroY - v * unit).toFixed(1)}`).reverse();
    paths[key] = buckets.length ? `M${top.join('L')}L${bottom.join('L')}Z` : '';
    edges[key] = buckets.length ? `M${top.join('L')}` : '';
  }
  const downUnit = maxDown > 0 ? (plot.bottom - lostTop) / maxDown : 0;
  const lostPts = buckets.map((b, i) => `${xs[i].toFixed(1)},${(lostTop + b.lost * downUnit).toFixed(1)}`);
  paths.lost = buckets.length && maxDown > 0
    ? `M${xs[0].toFixed(1)},${lostTop.toFixed(1)}L${lostPts.join('L')}L${xs[xs.length - 1].toFixed(1)},${lostTop.toFixed(1)}Z`
    : '';
  edges.lost = buckets.length && maxDown > 0 ? `M${lostPts.join('L')}` : '';

  const yTicks = [0, maxUp / 2, maxUp].map(v => ({ value: v, y: zeroY - v * unit }));
  const lostTicks = maxDown > 0 && plot.bottom - lostTop >= TICK_GAP
    ? [{ value: 0, y: lostTop }, { value: maxDown, y: plot.bottom }]
    : [];

  const spanMs = to - from;
  const day = 86_400_000;
  const stepDays = spanMs <= 8 * day ? 1 : 7;
  const firstMidnight = new Date(from);
  firstMidnight.setHours(24, 0, 0, 0);
  const xTicks: ChartGeometry['xTicks'] = [];
  for (let t = firstMidnight.getTime(); t < to; t += stepDays * day) {
    xTicks.push({ at: t, x: xOf(t), label: fmtTick(t, spanMs) });
  }

  return {
    width,
    height,
    plot,
    zeroY,
    lostTop,
    maxUp,
    maxDown,
    paths,
    edges,
    yTicks,
    lostTicks,
    xTicks,
    releases: series.releases.map(r => ({
      at: r.at,
      x: xOf(r.at),
      version: r.version,
      state: r.state,
      shipped: r.state === 'healthy' || r.state === 'degraded',
    })),
    xOf,
    bucketIndexAt: (x: number) => {
      if (buckets.length === 0) return -1;
      const t = from + ((x - plot.left) / Math.max(1, plot.right - plot.left)) * (to - from);
      const i = Math.floor((t - from) / series.bucketMs);
      return Math.max(0, Math.min(buckets.length - 1, i));
    },
  };
}

/** Tasks that were in `band` during bucket `i`, longest overlap first. */
export function tasksInBand(series: FlowSeries, i: number, band: BandKey): FlowTask[] {
  const b = series.buckets[i];
  if (!b) return [];
  const { from } = series.window;
  if (band === 'released') {
    return series.tasks.filter(t => t.shippedAt != null && t.shippedAt >= from && t.shippedAt < b.end)
      .sort((a, z) => z.shippedAt! - a.shippedAt!);
  }
  if (band === 'lost') {
    return series.tasks.filter(t => t.lostAt != null && t.lostAt >= from && t.lostAt < b.end)
      .sort((a, z) => z.lostAt! - a.lostAt!);
  }
  const scored = series.tasks.map(t => ({
    t,
    ms: t.segments
      .filter(s => s.stage === band)
      .reduce((m, s) => m + Math.max(0, Math.min(s.to, b.end) - Math.max(s.from, b.start)), 0),
  }));
  return scored.filter(x => x.ms > 0).sort((a, z) => z.ms - a.ms).map(x => x.t);
}

/** Agent-hours by role inside the window, largest first. */
export function roleHours(series: FlowSeries): { role: string; hours: number }[] {
  const by = new Map<string, number>();
  for (const b of series.buckets) {
    for (const [role, v] of Object.entries(b.running)) by.set(role, (by.get(role) ?? 0) + v * (b.end - b.start) / 3_600_000);
  }
  return [...by].map(([role, hours]) => ({ role, hours })).sort((a, z) => z.hours - a.hours || a.role.localeCompare(z.role));
}

export function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 10) return `${h.toFixed(1)}h`;
  return `${Math.round(h)}h`;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const h = ms / 3_600_000;
  if (h < 48) return formatHours(h);
  return `${(h / 24).toFixed(h < 240 ? 1 : 0)}d`;
}

export function formatShare(share: number | null): string {
  return share == null ? '—' : `${Math.round(share * 100)}%`;
}
