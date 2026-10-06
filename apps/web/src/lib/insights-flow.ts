/**
 * Insights flow: how a team's agent work moves to production, over time.
 *
 * A pure fold over worker rows (plus the team's releases). The unit is the
 * TASK, keyed like the usage rollups (`parentTaskId ?? taskId`), so a task
 * retried three times is one task. At any instant a task is in at most one
 * stage, by precedence:
 *
 *   running (an agent is working, split by role)
 *   > waiting (an agent is parked on a person's answer)
 *   > review  (a PR is open: CI, review, conflicts)
 *   > merged  (merged, waiting for a release; only where the workspace has releases)
 *
 * and two terminal outcomes, counted cumulatively from the window start:
 *   released (reached production: a healthy/degraded release carried it, or it
 *            merged in a workspace with no tracked release process). A release
 *            carries a merge when it names the task, or when it was cut after
 *            the change reached the trunk it releases from (a mission-branch
 *            merge reaches trunk when its mission's PR merges).
 *   lost     (failed or cancelled with no PR, or its PR closed unmerged)
 *
 * WIP stages are time-weighted per bucket (average tasks in that stage over the
 * bucket), so a ten-minute run in an hourly bucket reads as 0.17, not 0 or 1.
 *
 * Approximations:
 *   - "waiting" is only known for workers parked now.
 *   - a finished worker with no recorded end runs at most MAX_UNENDED_RUN_MS:
 *     its row keeps being touched by PR refreshes, so its last update is not
 *     when it stopped.
 *   - a PR's close time is its last GitHub check (`prLastCheckedAt`), unless a
 *     person recorded it abandoned. A PR superseded by another merged PR is
 *     neither shipped nor lost here: the PR that landed carries the shipping.
 *
 * Client-safe: no imports with runtime side effects.
 */

import type { InsightsUsageRow } from '../../../../packages/shared/src/insights';
import { LIVE_WORKER_STATUSES, TERMINAL_TASK_STATUSES } from '@buildd/shared';

export type FlowWindow = '7d' | '30d';
export const FLOW_WINDOWS: readonly FlowWindow[] = ['7d', '30d'];

const HOUR = 3_600_000;
const WINDOW_MS: Record<FlowWindow, number> = { '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR };

export function windowMsFor(window: FlowWindow): number {
  return WINDOW_MS[window];
}

/** Hourly for a week, six-hourly for a month: ~120-170 points either way. */
export function bucketMsFor(window: FlowWindow): number {
  return window === '7d' ? HOUR : 6 * HOUR;
}

export function isFlowWindow(value: unknown): value is FlowWindow {
  return typeof value === 'string' && (FLOW_WINDOWS as readonly string[]).includes(value);
}

/** One worker, with the task fields the fold needs. Times are epoch ms. */
export interface FlowWorkerRow {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  tier?: string | null;
  workerId: string;
  taskId: string | null;
  parentTaskId: string | null;
  taskTitle: string | null;
  taskStatus: string | null;
  roleSlug: string | null;
  missionId: string | null;
  workspaceId: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number | null;
  prNumber: number | null;
  mergedAt: number | null;
  prLifecycleStatus: string | null;
  prLastCheckedAt: number | null;
  /** Closed PR whose diff landed under another merged PR: not lost. */
  prSupersededAt: number | null;
  /** Closed PR a person declared abandoned. */
  prAbandonedAt: number | null;
  /** Branch the PR merged into; `mission/...` means a mission integration branch. */
  prBaseRef?: string | null;
}

export interface FlowReleaseRow {
  id: string;
  workspaceId: string;
  version: string | null;
  state: string;
  /** When it reached production (healthyAt ?? deployedAt ?? createdAt). */
  at: number;
  /** When its commit range was fixed (dispatchedAt ?? createdAt); defaults to `at`. */
  cutAt?: number;
}

export interface FlowInput {
  window: { from: number; to: number };
  bucketMs: number;
  now: number;
  workers: FlowWorkerRow[];
  releases: FlowReleaseRow[];
  releaseTasks: { releaseId: string; taskId: string }[];
  /** Workspaces that have ever recorded a release; elsewhere a merge ships. */
  releaseWorkspaceIds: string[];
  /** When each mission's own PR merged into trunk, for mission-branch merges. */
  missionTrunkMergedAt?: Record<string, number>;
}

export type FlowStage = 'running' | 'waiting' | 'review' | 'merged';

export interface FlowSegment {
  stage: FlowStage;
  /** Set on running segments. */
  role?: string;
  from: number;
  to: number;
}

export interface FlowTask {
  key: string;
  title: string;
  missionId: string | null;
  workspaceId: string;
  role: string;
  segments: FlowSegment[];
  shippedAt: number | null;
  lostAt: number | null;
  outcome?: 'In flight' | 'Completed';
  agentHours: number;
}

export interface FlowBucket {
  start: number;
  end: number;
  running: Record<string, number>;
  waiting: number;
  review: number;
  merged: number;
  /** Cumulative since the window start. */
  released: number;
  /** Cumulative since the window start. */
  lost: number;
}

export interface FlowHeadline {
  /** Agent-hours of shipped tasks over shipped + lost. Null when neither. */
  shippedShare: number | null;
  shippedHours: number;
  lostHours: number;
  inFlightHours: number;
  /** Finished without a PR (research, review, planning): neither shipped nor lost. */
  otherHours: number;
  shippedTasks: number;
  lostTasks: number;
  /** Releases that reached production in the window. */
  releases: number;
  /** Median of first agent start to production, over tasks shipped in the window. */
  medianStartToProdMs: number | null;
}

export interface FlowSeries {
  window: { from: number; to: number };
  bucketMs: number;
  buckets: FlowBucket[];
  releases: { at: number; version: string | null; state: string }[];
  tasks: FlowTask[];
  roles: string[];
  usage?: InsightsUsageRow[];
  workspaceNames?: Record<string, string>;
  headline: FlowHeadline;
}

export const UNASSIGNED_ROLE = 'unassigned';
const LIVE = new Set<string>(LIVE_WORKER_STATUSES);
const SHIPPED_RELEASE_STATES = new Set(['healthy', 'degraded']);
const CLOSED_PR = new Set(['closed', 'unresolvable']);
// Terminal task statuses that mean the work did not land (`completed` is the other one).
const LOST_TASK = new Set<string>(TERMINAL_TASK_STATUSES.filter(s => s !== 'completed'));

interface Interval { from: number; to: number; role?: string }

/** Longest a finished worker with no recorded end is counted as running. */
export const MAX_UNENDED_RUN_MS = 8 * HOUR;

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** When a started worker stopped running (or parked), and whether it is parked now. */
function runEnd(w: FlowWorkerRow, now: number): number {
  if (w.status === 'waiting_input') return Math.min(now, w.updatedAt ?? w.startedAt ?? now);
  if (w.completedAt != null) return w.completedAt;
  if (LIVE.has(w.status)) return now;
  const start = w.startedAt ?? now;
  return Math.min(w.updatedAt ?? start, start + MAX_UNENDED_RUN_MS, now);
}

function stageSegments(
  runs: Interval[], waits: Interval[], review: Interval | null, merged: Interval | null,
): FlowSegment[] {
  const edges = new Set<number>();
  for (const i of [...runs, ...waits, ...(review ? [review] : []), ...(merged ? [merged] : [])]) {
    edges.add(i.from);
    edges.add(i.to);
  }
  const points = [...edges].sort((a, b) => a - b);
  const out: FlowSegment[] = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k];
    const b = points[k + 1];
    const covers = (i: Interval) => i.from <= a && i.to >= b;
    const run = runs.find(covers);
    let seg: FlowSegment | null = null;
    if (run) seg = { stage: 'running', role: run.role ?? UNASSIGNED_ROLE, from: a, to: b };
    else if (waits.some(covers)) seg = { stage: 'waiting', from: a, to: b };
    else if (review && covers(review)) seg = { stage: 'review', from: a, to: b };
    else if (merged && covers(merged)) seg = { stage: 'merged', from: a, to: b };
    if (!seg) continue;
    const prev = out[out.length - 1];
    if (prev && prev.stage === seg.stage && prev.role === seg.role && prev.to === seg.from) prev.to = seg.to;
    else out.push(seg);
  }
  return out;
}

export function buildFlowSeries(input: FlowInput): FlowSeries {
  const { window, bucketMs, now } = input;
  const releaseWs = new Set(input.releaseWorkspaceIds);

  // Group workers by task key; remember which task ids belong to each key.
  const groups = new Map<string, FlowWorkerRow[]>();
  const keyOfTask = new Map<string, string>();
  const seenWorkers = new Set<string>();
  for (const w of input.workers) {
    if (w.startedAt == null || seenWorkers.has(w.workerId)) continue;
    seenWorkers.add(w.workerId);
    const key = w.parentTaskId ?? w.taskId ?? `worker:${w.workerId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(w);
    if (w.taskId) keyOfTask.set(w.taskId, key);
  }

  // Earliest production release per task key.
  const releaseById = new Map(input.releases.map(r => [r.id, r]));
  const firstShip = new Map<string, number>();
  for (const rt of input.releaseTasks) {
    const r = releaseById.get(rt.releaseId);
    const key = keyOfTask.get(rt.taskId) ?? (groups.has(rt.taskId) ? rt.taskId : undefined);
    if (!r || !key || !SHIPPED_RELEASE_STATES.has(r.state)) continue;
    const prev = firstShip.get(key);
    if (prev == null || r.at < prev) firstShip.set(key, r.at);
  }

  // Shipped releases per workspace, in cut order, for merges no release names.
  const shippedByWs = new Map<string, FlowReleaseRow[]>();
  for (const r of input.releases) {
    if (!SHIPPED_RELEASE_STATES.has(r.state)) continue;
    if (!shippedByWs.has(r.workspaceId)) shippedByWs.set(r.workspaceId, []);
    shippedByWs.get(r.workspaceId)!.push(r);
  }
  for (const list of shippedByWs.values()) list.sort((a, b) => (a.cutAt ?? a.at) - (b.cutAt ?? b.at));
  const missionTrunk = input.missionTrunkMergedAt ?? {};
  /** When the first shipped release cut after `trunkAt` reached production, or null. */
  function shipByCut(workspaceId: string, trunkAt: number): number | null {
    let best: number | null = null;
    for (const r of shippedByWs.get(workspaceId) ?? []) {
      if ((r.cutAt ?? r.at) < trunkAt || r.at > now) continue;
      if (best == null || r.at < best) best = r.at;
    }
    return best;
  }

  const tasks: FlowTask[] = [];
  const roleHours = new Map<string, number>();
  let shippedHours = 0, lostHours = 0, inFlightHours = 0, otherHours = 0;
  const startToProd: number[] = [];

  for (const [key, rows] of groups) {
    rows.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const own = rows.find(r => r.taskId === key) ?? rows[0];
    const runs: Interval[] = rows.map(r => ({
      from: r.startedAt!,
      to: Math.max(r.startedAt!, runEnd(r, now)),
      role: r.roleSlug ?? UNASSIGNED_ROLE,
    })).filter(i => i.to > i.from);
    const waits: Interval[] = rows
      .filter(r => r.status === 'waiting_input')
      .map(r => ({ from: Math.min(now, r.updatedAt ?? r.startedAt!), to: now }))
      .filter(i => i.to > i.from);

    // The PR that matters is the latest one opened for the task.
    const prRows = rows.filter(r => r.prNumber != null);
    const latestPr = prRows[prRows.length - 1];
    let review: Interval | null = null;
    let merged: Interval | null = null;
    let shippedAt: number | null = null;
    let lostAt: number | null = null;
    let settledQuietly = false;

    if (latestPr) {
      const same = prRows.filter(r => r.prNumber === latestPr.prNumber);
      const openedAt = Math.min(...same.map(r => r.completedAt ?? r.startedAt!));
      const mergedAt = same.reduce<number | null>((m, r) => (r.mergedAt != null && (m == null || r.mergedAt > m) ? r.mergedAt : m), null);
      if (mergedAt != null) {
        review = { from: openedAt, to: Math.max(openedAt, mergedAt) };
        if (releaseWs.has(own.workspaceId)) {
          const mergeRow = same.find(r => r.mergedAt === mergedAt) ?? latestPr;
          const viaMission = (mergeRow.prBaseRef ?? '').startsWith('mission/');
          const trunkAt = viaMission ? (mergeRow.missionId ? missionTrunk[mergeRow.missionId] : undefined) : mergedAt;
          const byCut = trunkAt != null ? shipByCut(own.workspaceId, Math.max(trunkAt, mergedAt)) : null;
          const byEdge = firstShip.get(key) ?? null;
          shippedAt = byEdge != null && byCut != null ? Math.min(byEdge, byCut) : (byEdge ?? byCut);
          merged = { from: mergedAt, to: shippedAt ?? now };
        } else {
          shippedAt = firstShip.get(key) ?? mergedAt;
        }
      } else if (latestPr.prSupersededAt != null) {
        // Landed under another PR, which carries the shipping; this one settles quietly.
        review = { from: openedAt, to: Math.max(openedAt, latestPr.prSupersededAt) };
        settledQuietly = true;
      } else if (latestPr.prAbandonedAt != null || (latestPr.prLifecycleStatus && CLOSED_PR.has(latestPr.prLifecycleStatus))) {
        lostAt = latestPr.prAbandonedAt ?? latestPr.prLastCheckedAt ?? latestPr.completedAt ?? openedAt;
        review = { from: openedAt, to: Math.max(openedAt, lostAt) };
      } else {
        review = { from: openedAt, to: now };
      }
    } else if (own.taskStatus && LOST_TASK.has(own.taskStatus) && !rows.some(r => LIVE.has(r.status))) {
      lostAt = Math.max(...runs.map(i => i.to), own.startedAt!);
    }

    const segments = stageSegments(runs, waits, review, merged)
      .map(s => ({ ...s, from: Math.max(s.from, window.from), to: Math.min(s.to, window.to) }))
      .filter(s => s.to > s.from);
    const inWindow = (t: number | null) => t != null && t >= window.from && t < window.to;
    if (segments.length === 0 && !inWindow(shippedAt) && !inWindow(lostAt)) continue;

    const agentHours = runs.reduce((h, i) => h + (i.to - i.from), 0) / HOUR;
    for (const s of segments) {
      if (s.stage === 'running') roleHours.set(s.role!, (roleHours.get(s.role!) ?? 0) + (s.to - s.from));
    }
    if (shippedAt != null) {
      shippedHours += agentHours;
      if (inWindow(shippedAt)) startToProd.push(shippedAt - rows[0].startedAt!);
    } else if (lostAt != null) lostHours += agentHours;
    else if ((settledQuietly || !latestPr) && !rows.some(r => LIVE.has(r.status))) otherHours += agentHours;
    else inFlightHours += agentHours;

    tasks.push({
      key,
      title: own.taskTitle ?? 'Untitled task',
      missionId: own.missionId,
      workspaceId: own.workspaceId,
      role: own.roleSlug ?? UNASSIGNED_ROLE,
      segments,
      shippedAt,
      lostAt,
      outcome: (settledQuietly || !latestPr) && !rows.some(r => LIVE.has(r.status)) ? 'Completed' : 'In flight',
      agentHours,
    });
  }

  const buckets: FlowBucket[] = [];
  const n = Math.max(0, Math.ceil((window.to - window.from) / bucketMs));
  for (let k = 0; k < n; k++) {
    const start = window.from + k * bucketMs;
    const end = Math.min(window.to, start + bucketMs);
    const b: FlowBucket = { start, end, running: {}, waiting: 0, review: 0, merged: 0, released: 0, lost: 0 };
    for (const t of tasks) {
      for (const s of t.segments) {
        const o = overlap(s.from, s.to, start, end) / bucketMs;
        if (o <= 0) continue;
        if (s.stage === 'running') b.running[s.role!] = (b.running[s.role!] ?? 0) + o;
        else b[s.stage] += o;
      }
      if (t.shippedAt != null && t.shippedAt >= window.from && t.shippedAt < end) b.released++;
      if (t.lostAt != null && t.lostAt >= window.from && t.lostAt < end) b.lost++;
    }
    buckets.push(b);
  }

  const windowReleases = input.releases
    .filter(r => r.at >= window.from && r.at <= window.to)
    .sort((a, b) => a.at - b.at);

  const settled = shippedHours + lostHours;
  const shippedTasks = tasks.filter(t => t.shippedAt != null && t.shippedAt >= window.from && t.shippedAt < window.to).length;
  return {
    window,
    bucketMs,
    // Token/cost counters are lifetime totals, attributed to workers started in
    // the window; time is clipped to the window, including runs already active.
    usage: [...groups.values()].flat().filter(w => w.startedAt! < window.to && runEnd(w, now) > window.from).map(w => ({
      role: w.roleSlug ?? UNASSIGNED_ROLE, tier: w.tier ?? null,
      tokens: w.startedAt! >= window.from ? (w.inputTokens ?? 0) + (w.outputTokens ?? 0) : 0,
      costUsd: w.startedAt! >= window.from ? w.costUsd ?? 0 : 0,
      hours: overlap(w.startedAt!, runEnd(w, now), window.from, window.to) / HOUR,
    })),
    buckets,
    releases: windowReleases.map(r => ({ at: r.at, version: r.version, state: r.state })),
    tasks,
    roles: [...roleHours].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r]) => r),
    headline: {
      shippedShare: settled > 0 ? shippedHours / settled : null,
      shippedHours,
      lostHours,
      inFlightHours,
      otherHours,
      shippedTasks,
      lostTasks: tasks.filter(t => t.lostAt != null).length,
      releases: windowReleases.filter(r => SHIPPED_RELEASE_STATES.has(r.state)).length,
      medianStartToProdMs: median(startToProd),
    },
  };
}
