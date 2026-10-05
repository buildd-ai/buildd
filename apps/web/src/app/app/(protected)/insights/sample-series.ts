/**
 * `?state=sample` for /app/insights: a synthetic team week, so the visual
 * audit can see a populated chart when the CI QA account's team has little
 * agent history (docs/specs/qa-capture-steps.md). Dev server only; production
 * ignores the param. Built through the real fold, so the sample can't drift
 * from what live data renders.
 */
import { buildFlowSeries, bucketMsFor, windowMsFor, type FlowSeries, type FlowWindow, type FlowWorkerRow } from '@/lib/insights-flow';

export type InsightsQaState = 'sample' | 'empty' | 'not-admin';
const QA_STATES: readonly InsightsQaState[] = ['sample', 'empty', 'not-admin'];

/**
 * `sample`: a populated synthetic window. `empty`: a window with no agent work.
 * `not-admin`: the card a member without view_team_usage sees. All three exist
 * so the visual audit can reach states the CI QA account's data can't produce.
 */
export function resolveInsightsQaState(raw: string | string[] | undefined, nodeEnv: string | undefined = process.env.NODE_ENV): InsightsQaState | null {
  if (nodeEnv !== 'development') return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (QA_STATES as readonly string[]).includes(value ?? '') ? (value as InsightsQaState) : null;
}

/** An empty window, through the real fold. */
export function emptyFlowSeries(window: FlowWindow, now = Date.now()): FlowSeries {
  return buildFlowSeries({
    window: { from: now - windowMsFor(window), to: now },
    bucketMs: bucketMsFor(window),
    now,
    workers: [],
    releases: [],
    releaseTasks: [],
    releaseWorkspaceIds: [],
  });
}

const H = 3_600_000;
const ROLES = ['builder', 'builder', 'builder', 'reviewer', 'organizer', 'researcher'];

/** Deterministic pseudo-random so screenshots are stable run to run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function sampleFlowSeries(window: FlowWindow, now = Date.now()): FlowSeries {
  const r = rng(42);
  const span = windowMsFor(window);
  const from = now - span;
  const workers: FlowWorkerRow[] = [];
  const releases: { id: string; workspaceId: string; version: string; state: string; at: number }[] = [];
  const releaseTasks: { releaseId: string; taskId: string }[] = [];
  const count = window === '7d' ? 60 : 220;
  for (let n = 0; n < count; n++) {
    const start = from + r() * (span - 2 * H);
    const run = (0.2 + r() * 1.8) * H;
    const role = ROLES[Math.floor(r() * ROLES.length)];
    const withPr = role === 'builder';
    const roll = r();
    const status = start + run > now ? 'running' : roll < 0.05 ? 'waiting_input' : roll < 0.12 ? 'failed' : 'completed';
    const done = status === 'completed' || status === 'failed';
    const merged = withPr && done && status !== 'failed' && r() < 0.8 ? start + run + (1 + r() * 10) * H : null;
    workers.push({
      workerId: `w${n}`,
      taskId: `t${n}`,
      parentTaskId: null,
      taskTitle: `${role === 'builder' ? 'feat' : role}: sample task ${n + 1}`,
      taskStatus: status === 'failed' ? 'failed' : done ? 'completed' : 'in_progress',
      roleSlug: role,
      missionId: null,
      workspaceId: 'sample-ws',
      status,
      startedAt: start,
      completedAt: done ? start + run : null,
      updatedAt: start + run * 0.6,
      prNumber: withPr && status !== 'failed' ? 1000 + n : null,
      mergedAt: merged != null && merged < now ? merged : null,
      prLifecycleStatus: merged != null && merged < now ? 'merged' : withPr ? 'pr_open' : null,
      prLastCheckedAt: null,
      prSupersededAt: null,
      prAbandonedAt: r() < 0.04 ? start + run + 2 * H : null,
    });
  }
  // A release roughly every day, carrying what merged since the last one.
  let prev = from;
  let v = 100;
  for (let t = from + 20 * H; t < now; t += (18 + r() * 12) * H) {
    const id = `r${v}`;
    releases.push({ id, workspaceId: 'sample-ws', version: `v0.${v}.0`, state: r() < 0.08 ? 'failed' : 'healthy', at: t });
    for (const w of workers) if (w.mergedAt != null && w.mergedAt >= prev && w.mergedAt < t) releaseTasks.push({ releaseId: id, taskId: w.taskId! });
    prev = t;
    v++;
  }
  return buildFlowSeries({
    window: { from, to: now },
    bucketMs: bucketMsFor(window),
    now,
    workers,
    releases,
    releaseTasks,
    releaseWorkspaceIds: ['sample-ws'],
  });
}
