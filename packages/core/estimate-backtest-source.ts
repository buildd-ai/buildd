/**
 * The replay half of the estimate backtest (scoring is `./estimate-backtest.ts`).
 *
 * Every completed `task_class='work'` task is estimated again as if it had
 * just been created: only from data that predates its `createdAt` — the same
 * cutoff `estimateTaskSizeFromSessions` applies to neighbour sessions
 * (`./task-size-estimate.ts`). A neighbour created at or after the cutoff is
 * also dropped before sizing, so a later task can never contribute.
 *
 * Actuals. Agent minutes = the sum, over the task's workers, of
 * completedAt − startedAt. Subagents run inside their parent worker's session
 * (they are not workers of their own), so their time is already inside that
 * span; summing workers neither double-counts nor misses them. Concurrent
 * workers on one task would add up, which is the agent time spent, not wall
 * time. Tokens = input + output, same sum.
 *
 * Fallback. When fewer than k neighbours can size a task the live path asks
 * Jev for an S/M/L bucket (`./task-size-bucket-source.ts`). Replaying that
 * would write decision-ledger rows and cost inference, so the replay uses the
 * rule verdict the decision falls back to — bucket M — which is the floor the
 * model has to beat, not the model itself.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from './db/client';
import { tasks, workers } from './db/schema';
import { SIZE_BUCKET_ESTIMATES } from './task-size-bucket-decision';
import { TASK_SIZE_NEIGHBOURS_K, estimateTaskSizeFromSessions, type NeighbourSession } from './task-size-estimate';
import type { BacktestRow } from './estimate-backtest';

export interface ReplayTask {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  createdAt: Date;
  completedAt: Date | null;
  kind?: string | null;
  complexity?: string | null;
  pathManifest?: string[] | null;
}

export interface ReplaySession extends NeighbourSession {
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface ReplayRow extends BacktestRow {
  taskId: string;
  workspaceId: string;
  actualTokens: number;
}

export interface ReplayDeps {
  /** Neighbour task ids for a task, in rank order. May include tasks from its future. */
  findNeighbours: (task: ReplayTask) => Promise<readonly string[]>;
  /** Fall back to bucket M below k neighbours. Default true. */
  bucketFallback?: boolean;
  k?: number;
  /** Cold start: pretend the workspace is new — no neighbours, no history. */
  heldOut?: boolean;
}

const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : NaN);

export function actualOf(sessions: readonly ReplaySession[]): { minutes: number; tokens: number } {
  let minutes = 0;
  let tokens = 0;
  for (const s of sessions) {
    const span = (ms(s.completedAt) - ms(s.startedAt)) / 60_000;
    if (Number.isFinite(span) && span > 0) minutes += span;
    tokens += (s.inputTokens ?? 0) + (s.outputTokens ?? 0);
  }
  return { minutes, tokens };
}

/** Pure given its inputs: tasks with an actual, replayed against only their past. */
export async function replayTasks(
  all: readonly ReplayTask[],
  sessions: readonly ReplaySession[],
  deps: ReplayDeps,
): Promise<ReplayRow[]> {
  const k = deps.k ?? TASK_SIZE_NEIGHBOURS_K;
  const byTask = new Map<string, ReplaySession[]>();
  for (const s of sessions) {
    if (!s.taskId) continue;
    const list = byTask.get(s.taskId) ?? [];
    list.push(s);
    byTask.set(s.taskId, list);
  }
  const createdAt = new Map(all.map(t => [t.id, t.createdAt.getTime()]));

  const rows: ReplayRow[] = [];
  for (const task of all) {
    const actual = actualOf(byTask.get(task.id) ?? []);
    if (actual.minutes <= 0) continue;
    const cutoff = task.createdAt;

    let estimate: { minutes: number } | null = null;
    if (!deps.heldOut) {
      const found = await deps.findNeighbours(task);
      // A neighbour made at/after the cutoff is the future; its sessions are
      // also filtered by cutoff inside the estimator, this is the second lock.
      const ids = found.filter(id => id !== task.id && (createdAt.get(id) ?? Infinity) < cutoff.getTime());
      if (ids.length >= k) {
        estimate = estimateTaskSizeFromSessions(ids, sessions as NeighbourSession[], { k, cutoff });
      }
    }

    const priorCompleted = deps.heldOut
      ? 0
      : all.filter(t => t.workspaceId === task.workspaceId && t.completedAt && t.completedAt.getTime() < cutoff.getTime()).length;

    const base = { taskId: task.id, workspaceId: task.workspaceId, actual: actual.minutes, actualTokens: actual.tokens, priorCompleted };
    if (estimate) rows.push({ ...base, source: 'neighbours', p50: estimate.minutes, p80: null });
    else if (deps.bucketFallback !== false) rows.push({ ...base, source: 'bucket', p50: SIZE_BUCKET_ESTIMATES.M.minutes, p80: null });
    else rows.push({ ...base, source: 'none', p50: null, p80: null });
  }
  return rows;
}

export async function loadReplayInput(opts: { workspaceId?: string } = {}): Promise<{ tasks: ReplayTask[]; sessions: ReplaySession[] }> {
  const where = and(
    eq(tasks.taskClass, 'work'),
    eq(tasks.status, 'completed'),
    ...(opts.workspaceId ? [eq(tasks.workspaceId, opts.workspaceId)] : []),
  );
  const rows = await db
    .select({
      id: tasks.id, workspaceId: tasks.workspaceId, title: tasks.title, description: tasks.description,
      createdAt: tasks.createdAt, completedAt: tasks.completedAt,
      kind: tasks.kind, complexity: tasks.complexity, pathManifest: tasks.pathManifest,
    })
    .from(tasks)
    .where(where);
  const taskRows = rows as ReplayTask[];
  const sessions: ReplaySession[] = [];
  for (let i = 0; i < taskRows.length; i += 500) {
    const ids = taskRows.slice(i, i + 500).map(t => t.id);
    const part = await db
      .select({
        taskId: workers.taskId, filesChanged: workers.filesChanged, startedAt: workers.startedAt,
        completedAt: workers.completedAt, inputTokens: workers.inputTokens, outputTokens: workers.outputTokens,
      })
      .from(workers)
      .where(and(inArray(workers.taskId, ids), eq(workers.status, 'completed'), isNotNull(workers.startedAt), isNotNull(workers.completedAt)));
    sessions.push(...(part as ReplaySession[]));
  }
  return { tasks: taskRows, sessions };
}
