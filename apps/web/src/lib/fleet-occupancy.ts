/**
 * Fleet occupancy: how many workers were busy over time, the "water level".
 *
 * A pure fold over worker rows. A worker holds its slot from `startedAt` until:
 *   - `completedAt`, when it finished with one;
 *   - now, while it is live (running, starting, or parked on a person's answer:
 *     a parked worker still holds its runner slot);
 *   - otherwise its last update, capped at MAX_UNENDED_RUN_MS, the same rule
 *     Insights uses (its row keeps being touched by PR refreshes, so the last
 *     update is not when it stopped).
 *
 * Two series, never summed: runner slots, and interactive sessions (claimed
 * with claim_task from an MCP session; they use no runner slot). Placeholder
 * workers no runner executed count as neither (see `executorOf`).
 *
 * Each bucket carries the time-weighted average busy count and the peak at any
 * instant, so a burst of short runs reads as a peak, not as a flat average.
 *
 * There is no capacity series: slot counts are not stored over time, so the
 * only honest ceiling is today's, and that is the caller's to label as such.
 *
 * Client-safe: no imports with runtime side effects.
 */

import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { executorOf } from './executor';
import { MAX_UNENDED_RUN_MS } from './insights-flow';

export type OccupancyWindow = '24h' | '7d' | '30d';
export const OCCUPANCY_WINDOWS: readonly OccupancyWindow[] = ['24h', '7d', '30d'];

const MIN = 60_000;
const HOUR = 60 * MIN;
const WINDOW_MS: Record<OccupancyWindow, number> = { '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR };
/** 96, 168 and 120 points: enough to see a day's shape, few enough for a sparkline. */
const BUCKET_MS: Record<OccupancyWindow, number> = { '24h': 15 * MIN, '7d': HOUR, '30d': 6 * HOUR };

export function occupancyWindowMs(window: OccupancyWindow): number {
  return WINDOW_MS[window];
}

export function occupancyBucketMs(window: OccupancyWindow): number {
  return BUCKET_MS[window];
}

export function isOccupancyWindow(value: unknown): value is OccupancyWindow {
  return typeof value === 'string' && (OCCUPANCY_WINDOWS as readonly string[]).includes(value);
}

/** One worker. Times are epoch ms. */
export interface OccupancyWorkerRow {
  /** `workers.runner`: decides runner slot vs session. */
  runner: string | null;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number | null;
}

export interface OccupancyLevel {
  /** Time-weighted average busy count. */
  avg: number;
  /** Most busy at any one instant. */
  peak: number;
}

export interface OccupancyBucket {
  /** Bucket start, epoch ms. */
  t: number;
  runner: OccupancyLevel;
  sessions: OccupancyLevel;
}

export interface OccupancySeries {
  windowKey: OccupancyWindow;
  window: { from: number; to: number };
  bucketMs: number;
  buckets: OccupancyBucket[];
  /** Over the whole window: the highest peak, and the time-weighted mean. */
  summary: { runner: OccupancyLevel; sessions: OccupancyLevel };
}

const LIVE = new Set<string>(LIVE_WORKER_STATUSES);

/** When a started worker stopped holding its slot. */
export function occupancyEnd(w: OccupancyWorkerRow, now: number): number {
  if (w.completedAt != null) return w.completedAt;
  if (LIVE.has(w.status)) return now;
  const start = w.startedAt ?? now;
  return Math.min(w.updatedAt ?? start, start + MAX_UNENDED_RUN_MS, now);
}

/** The window's buckets: the last one is the bucket `now` falls inside (partial). */
export function occupancyBuckets(window: OccupancyWindow, now: number): { from: number; bucketMs: number; count: number } {
  const bucketMs = BUCKET_MS[window];
  const count = WINDOW_MS[window] / bucketMs;
  const lastStart = Math.ceil(now / bucketMs) * bucketMs - bucketMs;
  return { from: lastStart - (count - 1) * bucketMs, bucketMs, count };
}

interface Edge { t: number; d: number }

function level(edges: Edge[], from: number, now: number, bucketMs: number, count: number): { buckets: OccupancyLevel[]; summary: OccupancyLevel } {
  const busyMs = new Array<number>(count).fill(0);
  const peak = new Array<number>(count).fill(0);
  // Ends sort before starts at the same instant: back-to-back runs are not overlap.
  edges.sort((a, b) => a.t - b.t || a.d - b.d);
  let c = 0;
  for (let i = 0; i < edges.length; i++) {
    c += edges[i].d;
    const a = Math.max(edges[i].t, from);
    const b = Math.min(i + 1 < edges.length ? edges[i + 1].t : now, now);
    if (c <= 0 || b <= a) continue;
    const first = Math.floor((a - from) / bucketMs);
    const last = Math.min(count - 1, Math.ceil((b - from) / bucketMs) - 1);
    for (let k = first; k <= last; k++) {
      const k0 = from + k * bucketMs;
      const overlap = Math.min(b, k0 + bucketMs) - Math.max(a, k0);
      if (overlap <= 0) continue;
      busyMs[k] += c * overlap;
      if (c > peak[k]) peak[k] = c;
    }
  }
  const buckets = busyMs.map((ms, k) => {
    const k0 = from + k * bucketMs;
    const span = Math.min(k0 + bucketMs, now) - k0;
    return { avg: span > 0 ? ms / span : 0, peak: peak[k] };
  });
  const total = busyMs.reduce((s, v) => s + v, 0);
  return { buckets, summary: { avg: now > from ? total / (now - from) : 0, peak: Math.max(0, ...peak) } };
}

export function buildOccupancySeries(input: { window: OccupancyWindow; now: number; workers: OccupancyWorkerRow[] }): OccupancySeries {
  const { window, now, workers } = input;
  const { from, bucketMs, count } = occupancyBuckets(window, now);
  const runnerEdges: Edge[] = [];
  const sessionEdges: Edge[] = [];
  for (const w of workers) {
    if (w.startedAt == null) continue;
    const executor = executorOf(w.runner);
    if (executor === 'other') continue;
    const start = w.startedAt;
    const end = Math.min(occupancyEnd(w, now), now);
    if (end <= start || end <= from) continue;
    const into = executor === 'interactive' ? sessionEdges : runnerEdges;
    into.push({ t: start, d: 1 }, { t: end, d: -1 });
  }
  const runner = level(runnerEdges, from, now, bucketMs, count);
  const sessions = level(sessionEdges, from, now, bucketMs, count);
  return {
    windowKey: window,
    window: { from, to: now },
    bucketMs,
    buckets: runner.buckets.map((r, k) => ({ t: from + k * bucketMs, runner: r, sessions: sessions.buckets[k] })),
    summary: { runner: runner.summary, sessions: sessions.summary },
  };
}
