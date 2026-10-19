/**
 * Fleet occupancy: how many workers were busy over time, the "water level".
 *
 * A pure fold over worker rows. A worker holds its slot from `startedAt` until:
 *   - `completedAt`, when it finished with one;
 *   - now, while it is live (running, starting, or parked on a person's answer:
 *     a parked worker still holds its runner slot);
 *   - otherwise its last update, capped at MAX_UNENDED_RUN_MS (shared with
 *     Insights) (its row keeps being touched by PR refreshes, so the last
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
import { RUNNER_CLASSES, type RunnerClass } from './runner-ownership';

export type OccupancyWindow = '24h' | '7d' | '30d';
export const OCCUPANCY_WINDOWS: readonly OccupancyWindow[] = ['24h', '7d', '30d'];

const MIN = 60_000;
const HOUR = 60 * MIN;
const WINDOW_MS: Record<OccupancyWindow, number> = { '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR };
/** 96, 168 and 30 points: a day in 15 minutes, a week by the hour, a month by the day. */
const BUCKET_MS: Record<OccupancyWindow, number> = { '24h': 15 * MIN, '7d': HOUR, '30d': 24 * HOUR };

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
  /** `workers.claimedByUserId`: the accountable principal. Null/absent: unattributed, never guessed. */
  ownerId?: string | null;
  /**
   * `tasks.createdByUserId`: the task's owner. For runner work it decides
   * mine/others, so a task on a managed runner belongs to its owner and not to
   * whichever key claimed it. Absent (older callers): the claimer decides. Null:
   * a service-owned or unowned task, unattributed. Interactive sessions always
   * belong to their claimer.
   */
  taskOwnerId?: string | null;
  /** The runner's ownership class (lib/runner-ownership.ts); absent reads as unknown. */
  runnerClass?: RunnerClass;
}

export interface OccupancyLevel {
  /** Time-weighted average busy count. */
  avg: number;
  /** Most busy at any one instant. */
  peak: number;
}

/** Who a slot's work belongs to, relative to the viewer. Every worker lands in exactly one. */
export type OccupancyOwner = 'mine' | 'others' | 'unattributed';
export const OCCUPANCY_OWNERS: readonly OccupancyOwner[] = ['mine', 'others', 'unattributed'];

export type OccupancyBreakdown = Record<OccupancyOwner, OccupancyLevel>;

export interface OccupancyBucket {
  /** Bucket start, epoch ms. */
  t: number;
  runner: OccupancyLevel;
  sessions: OccupancyLevel;
  /**
   * The same two series split by owner. The parts' `avg` sum to the total's;
   * `peak` does not (the parts peak at different instants), so a part's peak is
   * at most the total's.
   */
  runnerBy: OccupancyBreakdown;
  sessionsBy: OccupancyBreakdown;
}

/**
 * How much of the window's runner work carries a resolvable identity. Counts
 * are workers (not slot-time) that held a runner slot in the window. Missing
 * identity is counted, never guessed: such work shows as "unattributed" /
 * "unknown" and `ownerMissing <= total`, `runnerMissing <= total`.
 */
export interface OccupancyCoverage {
  /** Runner workers that held a slot in the window. */
  total: number;
  /** No task owner (or claimer) recorded: shown as Other / unattributed. */
  ownerMissing: number;
  /** No runner account, or an account with no recorded ownership: class unknown. */
  runnerMissing: number;
}

export interface OccupancySeries {
  windowKey: OccupancyWindow;
  window: { from: number; to: number };
  bucketMs: number;
  buckets: OccupancyBucket[];
  /** Over the whole window: the highest peak, and the time-weighted mean. */
  summary: {
    runner: OccupancyLevel;
    sessions: OccupancyLevel;
    runnerBy: OccupancyBreakdown;
    sessionsBy: OccupancyBreakdown;
    /** Runner slots by whose runner held them, independent of whose task it was. */
    runnerByClass: Record<RunnerClass, OccupancyLevel>;
    /** Identity completeness of the runner work in the window; see `OccupancyCoverage`. */
    coverage: OccupancyCoverage;
  };
  /**
   * Runner-slot usage per attributed member over the window, busiest first.
   * Work with no recorded owner is not here (it is `runnerBy.unattributed`).
   * `name` is filled in by the API from the member's profile, never guessed.
   */
  members?: OccupancyMember[];
}

export interface OccupancyMember extends OccupancyLevel {
  id: string;
  name?: string | null;
  /** The viewer's own row. */
  isMe?: boolean;
}

const LIVE = new Set<string>(LIVE_WORKER_STATUSES);

/**
 * Longest a finished worker with no recorded end is counted as running. Shared
 * with Insights (lib/insights-flow.ts imports it from here, so the two charts
 * agree on how long an unended run lasted).
 */
export const MAX_UNENDED_RUN_MS = 8 * HOUR;

/** When a started worker stopped holding its slot. */
export function occupancyEnd(w: OccupancyWorkerRow, now: number): number {
  if (w.completedAt != null) return w.completedAt;
  if (LIVE.has(w.status)) return now;
  const start = w.startedAt ?? now;
  return Math.min(w.updatedAt ?? start, start + MAX_UNENDED_RUN_MS, now);
}

/** Most a UTC offset can be, either way (UTC-12 to UTC+14). */
export const MAX_TZ_OFFSET_MS = 14 * HOUR;

/**
 * The window's buckets: the last one is the bucket `now` falls inside (partial).
 * `tzOffsetMs` (local time minus UTC) puts daily boundaries at the viewer's
 * midnight; it changes nothing for 15-minute and hourly buckets in whole-hour zones.
 */
export function occupancyBuckets(window: OccupancyWindow, now: number, tzOffsetMs = 0): { from: number; bucketMs: number; count: number } {
  const bucketMs = BUCKET_MS[window];
  const count = WINDOW_MS[window] / bucketMs;
  const off = Math.max(-MAX_TZ_OFFSET_MS, Math.min(MAX_TZ_OFFSET_MS, tzOffsetMs));
  const lastStart = Math.ceil((now + off) / bucketMs) * bucketMs - bucketMs - off;
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

/**
 * The one principal a worker's slot time belongs to, for mine/others, member
 * rows and the live "mine" flag alike. Runner work follows the task owner when
 * the caller recorded one (null = a service-owned task, nobody); interactive
 * sessions and callers that pass no task owner follow the claimer. The
 * runner's ownership class is a separate dimension and never decides this.
 */
export function workPrincipal(w: { ownerId?: string | null; taskOwnerId?: string | null }, executor: 'runner' | 'interactive'): string | null {
  return (executor === 'runner' && w.taskOwnerId !== undefined ? w.taskOwnerId : w.ownerId) ?? null;
}

function ownerOf(w: OccupancyWorkerRow, viewerId: string | null | undefined, executor: 'runner' | 'interactive'): OccupancyOwner {
  const owner = workPrincipal(w, executor);
  if (!owner) return 'unattributed';
  return viewerId && owner === viewerId ? 'mine' : 'others';
}

type OwnerEdges = Record<OccupancyOwner, Edge[]>;
const emptyEdges = (): OwnerEdges => ({ mine: [], others: [], unattributed: [] });

/** Total and per-owner levels from one set of edges; the total is the union, not a sum of parts. */
function split(edges: OwnerEdges, from: number, now: number, bucketMs: number, count: number) {
  const total = level([...edges.mine, ...edges.others, ...edges.unattributed], from, now, bucketMs, count);
  const parts = {
    mine: level(edges.mine, from, now, bucketMs, count),
    others: level(edges.others, from, now, bucketMs, count),
    unattributed: level(edges.unattributed, from, now, bucketMs, count),
  };
  const at = (k: number): OccupancyBreakdown => ({ mine: parts.mine.buckets[k], others: parts.others.buckets[k], unattributed: parts.unattributed.buckets[k] });
  const summary: OccupancyBreakdown = { mine: parts.mine.summary, others: parts.others.summary, unattributed: parts.unattributed.summary };
  return { total, at, summary };
}

export function buildOccupancySeries(input: { window: OccupancyWindow; now: number; workers: OccupancyWorkerRow[]; tzOffsetMs?: number; viewerId?: string | null }): OccupancySeries {
  const { window, now, workers } = input;
  const { from, bucketMs, count } = occupancyBuckets(window, now, input.tzOffsetMs ?? 0);
  const runnerEdges = emptyEdges();
  const sessionEdges = emptyEdges();
  const memberEdges = new Map<string, Edge[]>();
  const coverage: OccupancyCoverage = { total: 0, ownerMissing: 0, runnerMissing: 0 };
  const classEdges = Object.fromEntries(RUNNER_CLASSES.map(c => [c, [] as Edge[]])) as Record<RunnerClass, Edge[]>;
  for (const w of workers) {
  if (w.startedAt == null) continue;
  const executor = executorOf(w.runner);
  if (executor === 'other') continue;
  const start = w.startedAt;
  const end = Math.min(occupancyEnd(w, now), now);
  if (end <= start || end <= from) continue;
  const into = (executor === 'interactive' ? sessionEdges : runnerEdges)[ownerOf(w, input.viewerId, executor)];
  into.push({ t: start, d: 1 }, { t: end, d: -1 });
  const principal = workPrincipal(w, executor);
  if (executor !== 'interactive' && principal) {
      const e = memberEdges.get(principal) ?? [];
      e.push({ t: start, d: 1 }, { t: end, d: -1 });
      memberEdges.set(principal, e);
    }
  if (executor === 'runner') {
    classEdges[w.runnerClass ?? 'unknown'].push({ t: start, d: 1 }, { t: end, d: -1 });
    coverage.total += 1;
    if (ownerOf(w, null, executor) === 'unattributed') coverage.ownerMissing += 1;
    if ((w.runnerClass ?? 'unknown') === 'unknown') coverage.runnerMissing += 1;
  }
  }
  const members: OccupancyMember[] = [...memberEdges].map(([id, edges]) => {
    const s = level(edges, from, now, bucketMs, count).summary;
    return { id, avg: s.avg, peak: s.peak, isMe: !!input.viewerId && id === input.viewerId };
  }).sort((a, b) => b.avg - a.avg || a.id.localeCompare(b.id));
  const runner = split(runnerEdges, from, now, bucketMs, count);
  const sessions = split(sessionEdges, from, now, bucketMs, count);
  const runnerByClass = Object.fromEntries(RUNNER_CLASSES.map(c => [c, level(classEdges[c], from, now, bucketMs, count).summary])) as Record<RunnerClass, OccupancyLevel>;
  return {
    windowKey: window,
    window: { from, to: now },
    bucketMs,
    buckets: runner.total.buckets.map((r, k) => ({
      t: from + k * bucketMs,
      runner: r,
      sessions: sessions.total.buckets[k],
      runnerBy: runner.at(k),
      sessionsBy: sessions.at(k),
    })),
    summary: { runner: runner.total.summary, sessions: sessions.total.summary, runnerBy: runner.summary, sessionsBy: sessions.summary, runnerByClass, coverage },
    members,
  };
}

/**
 * Member attribution limited to the people the viewer may see: current members
 * of the team being viewed. Work by anyone else (a former member, or a person
 * from another team on a shared runner) stays in the totals and in Others, but
 * gets no named row. The members list is a view of the totals, never a gate on
 * them, and a client filter is not an access boundary: this runs server-side.
 */
export function scopeMembers(series: OccupancySeries, teamMemberIds: ReadonlySet<string>): OccupancySeries {
  return { ...series, members: (series.members ?? []).filter(m => teamMemberIds.has(m.id)) };
}

const EPS = 1e-6;

/**
 * Where the owner split fails to add up to the total, as readable lines; empty
 * when every bucket and the window summary reconcile. Checked per series
 * (runner slots, sessions), never across them: the two are not summed.
 */
export function occupancyDiscrepancies(series: OccupancySeries): string[] {
  const out: string[] = [];
  const sum = (b: OccupancyBreakdown, f: 'avg' | 'peak') => OCCUPANCY_OWNERS.reduce((s, o) => s + b[o][f], 0);
  const check = (label: string, total: OccupancyLevel, by: OccupancyBreakdown) => {
    if (Math.abs(sum(by, 'avg') - total.avg) > EPS) out.push(`${label}: owner avg ${sum(by, 'avg')} != total ${total.avg}`);
    for (const o of OCCUPANCY_OWNERS) if (by[o].peak > total.peak) out.push(`${label}: ${o} peak ${by[o].peak} > total peak ${total.peak}`);
    if (total.peak > sum(by, 'peak')) out.push(`${label}: total peak ${total.peak} > sum of owner peaks ${sum(by, 'peak')}`);
  };
  for (const b of series.buckets) {
    check(`runner@${b.t}`, b.runner, b.runnerBy);
    check(`sessions@${b.t}`, b.sessions, b.sessionsBy);
  }
  check('runner summary', series.summary.runner, series.summary.runnerBy);
  check('sessions summary', series.summary.sessions, series.summary.sessionsBy);
  const classAvg = RUNNER_CLASSES.reduce((s, c) => s + series.summary.runnerByClass[c].avg, 0);
  if (Math.abs(classAvg - series.summary.runner.avg) > EPS) out.push(`runner summary: class avg ${classAvg} != total ${series.summary.runner.avg}`);
  return out;
}
