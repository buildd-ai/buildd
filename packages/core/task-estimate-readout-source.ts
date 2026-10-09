/**
 * The query half of `./task-estimate-readout.ts`: the team's frozen estimates
 * joined to their stored actuals, plus the area-cluster model per workspace.
 * One estimator version per readout (defaults to the current one).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { taskEstimateActuals, taskEstimates, tasks, workspaces } from './db/schema';
import { ESTIMATOR_VERSION } from './task-estimate';
import { loadClusterModel } from './task-estimate-source';
import { computeTaskEstimateReadout, type LiveEstimateRow, type TaskEstimateReadout } from './task-estimate-readout';
import type { AreaCluster } from './task-area-clusters';

export const READOUT_ROW_LIMIT = 5000;
/** Workspaces whose cluster model one response carries. */
export const READOUT_MAX_WORKSPACES = 20;

/**
 * Estimates with actuals for one team and one version. `priorCompleted` is the
 * workspace's completed work tasks that had finished when the estimate was
 * frozen, the backtest's learning-curve axis (a task's finish is its last
 * completed session's end, as in `loadReplayInput`).
 */
export async function fetchLiveEstimateRows(teamId: string, estimatorVersion = ESTIMATOR_VERSION): Promise<LiveEstimateRow[]> {
  const rows = await db
    .select({
      taskId: taskEstimates.taskId,
      workspaceId: taskEstimates.workspaceId,
      estimatorVersion: taskEstimates.estimatorVersion,
      p50Minutes: taskEstimates.p50Minutes,
      p80Minutes: taskEstimates.p80Minutes,
      p50Tokens: taskEstimates.p50Tokens,
      p80Tokens: taskEstimates.p80Tokens,
      expectedRepairs: taskEstimates.expectedRepairs,
      explanation: taskEstimates.explanation,
      actualMinutes: taskEstimateActuals.agentMinutes,
      actualTokens: taskEstimateActuals.tokens,
      actualRepairs: taskEstimateActuals.repairs,
      kind: tasks.kind,
      priorCompleted: sql<number>`(
        SELECT COUNT(*) FROM (
          SELECT w.task_id
            FROM workers w
            JOIN tasks pt ON pt.id = w.task_id
           WHERE pt.workspace_id = ${taskEstimates.workspaceId}
             AND pt.task_class = 'work'
             AND pt.status = 'completed'
             AND w.status = 'completed'
             AND w.completed_at IS NOT NULL
           GROUP BY w.task_id
          HAVING MAX(w.completed_at) < ${taskEstimates.createdAt}
        ) done
      )`.mapWith(Number),
    })
    .from(taskEstimates)
    .innerJoin(taskEstimateActuals, eq(taskEstimateActuals.taskId, taskEstimates.taskId))
    .innerJoin(tasks, eq(tasks.id, taskEstimates.taskId))
    .where(and(eq(taskEstimates.teamId, teamId), eq(taskEstimates.estimatorVersion, estimatorVersion), eq(tasks.taskClass, 'work')))
    .orderBy(desc(taskEstimates.createdAt))
    .limit(READOUT_ROW_LIMIT);
  return rows as LiveEstimateRow[];
}

export async function runTaskEstimateReadout(teamId: string, estimatorVersion = ESTIMATOR_VERSION): Promise<TaskEstimateReadout> {
  return computeTaskEstimateReadout(await fetchLiveEstimateRows(teamId, estimatorVersion));
}

export interface WorkspaceClusters {
  workspaceId: string;
  workspaceName: string;
  /** Completed tasks the model was built from. */
  tasks: number;
  clusters: AreaCluster[];
}

/**
 * How the model sees each workspace: its clusters with n and quantiles.
 * Per workspace, never merged: a cluster label is a path in one repo.
 */
export async function loadTeamClusters(teamId: string, now = new Date()): Promise<WorkspaceClusters[]> {
  const spaces = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.teamId, teamId))
    .limit(READOUT_MAX_WORKSPACES);
  const out: WorkspaceClusters[] = [];
  for (const w of spaces) {
    try {
      const model = await loadClusterModel(w.id, now);
      if (model.clusters.length > 0) out.push({ workspaceId: w.id, workspaceName: w.name, tasks: model.tasks, clusters: model.clusters });
    } catch (err) {
      console.warn(`[task-estimate] clusters unavailable for workspace ${w.id}: ${(err as Error)?.name ?? 'Error'}`);
    }
  }
  return out;
}
