/**
 * Each of a runner's own workers' task estimate, in minutes: the frozen p50
 * the Queue and the mission page show, under the same team switch. A runner
 * reads it when an update opens its window, to decide which agents finish and
 * which pause (spec 47c97f48, R-2). A worker of another account, or a task
 * without an estimate, reads null: the runner then pauses that agent.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { taskEstimates, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { taskEstimatesEnabled } from '@buildd/core/task-estimate-source';
import { taskEstimatesDefaultOn } from '@buildd/core/task-estimate-rollout';
import { ESTIMATOR_VERSION } from '@buildd/core/task-estimate';

export const MAX_ESTIMATE_IDS = 50;

export interface WorkerTaskRow { workerId: string; taskId: string | null; teamId: string | null }
export interface EstimateRow { taskId: string; p50Minutes: number }

export interface WorkerEstimateDeps {
  /** This account's workers among `workerIds`, with their task and team. */
  workers(accountId: string, workerIds: string[]): Promise<WorkerTaskRow[]>;
  enabled(teamId: string): Promise<boolean>;
  /** Newest first. */
  estimates(teamId: string, taskIds: string[]): Promise<EstimateRow[]>;
  calibrated(): boolean;
}

const realDeps: WorkerEstimateDeps = {
  workers: async (accountId, workerIds) => db
    .select({ workerId: workers.id, taskId: workers.taskId, teamId: workspaces.teamId })
    .from(workers)
    .leftJoin(tasks, eq(tasks.id, workers.taskId))
    .leftJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
    .where(and(eq(workers.accountId, accountId), inArray(workers.id, workerIds))),
  enabled: (teamId) => taskEstimatesEnabled(teamId),
  estimates: async (teamId, taskIds) => db
    .select({ taskId: taskEstimates.taskId, p50Minutes: taskEstimates.p50Minutes })
    .from(taskEstimates)
    .where(and(eq(taskEstimates.teamId, teamId), eq(taskEstimates.estimatorVersion, ESTIMATOR_VERSION), inArray(taskEstimates.taskId, taskIds)))
    .orderBy(desc(taskEstimates.createdAt)),
  calibrated: () => taskEstimatesDefaultOn(),
};

export async function loadWorkerEstimates(
  accountId: string,
  workerIds: string[],
  deps: WorkerEstimateDeps = realDeps,
): Promise<Record<string, number | null>> {
  const ids = [...new Set(workerIds)].slice(0, MAX_ESTIMATE_IDS);
  const out: Record<string, number | null> = Object.fromEntries(ids.map(id => [id, null]));
  if (ids.length === 0 || !deps.calibrated()) return out;
  const rows = await deps.workers(accountId, ids);
  const byTeam = new Map<string, WorkerTaskRow[]>();
  for (const r of rows) {
    if (!r.taskId || !r.teamId) continue;
    byTeam.set(r.teamId, [...(byTeam.get(r.teamId) ?? []), r]);
  }
  await Promise.all([...byTeam].map(async ([teamId, list]) => {
    if (!(await deps.enabled(teamId).catch(() => false))) return;
    const est = await deps.estimates(teamId, list.map(r => r.taskId!)).catch(() => []);
    const first = new Map<string, number>();
    for (const e of est) if (!first.has(e.taskId)) first.set(e.taskId, e.p50Minutes);
    for (const r of list) {
      const m = first.get(r.taskId!);
      out[r.workerId] = typeof m === 'number' && Number.isFinite(m) ? Math.round(m) : null;
    }
  }));
  return out;
}
