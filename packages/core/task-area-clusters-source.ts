/**
 * The read half of `./task-area-clusters.ts`: the same completed work tasks and
 * worker sessions the estimate backtest replays (`loadReplayInput`), joined to
 * the files each task's merged diff touched and the repair attempts it needed.
 * Read-only; nothing here writes `tasks.path_manifest`.
 *
 * `asOf` applies the replay's cutoff (`createdAt < asOf`) in `buildClusterTasks`
 * and again inside `deriveClusters`, so a model can be built as of any date.
 */
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from './db/client';
import { tasks } from './db/schema';
import { actualOf, loadReplayInput, type ReplaySession, type ReplayTask } from './estimate-backtest-source';
import { TASK_AREA_FALLBACK } from './task-area-prediction';
import { fetchNeighbourPaths } from './task-area-prediction-source';
import type { ClusterTask } from './task-area-clusters';

/** Pure join of the loaded pieces. Tasks with no diff files are kept (empty `files`). */
export function buildClusterTasks(
  all: readonly ReplayTask[],
  sessions: readonly ReplaySession[],
  filesByTask: ReadonlyMap<string, readonly string[]>,
  repairsByTask: ReadonlyMap<string, number>,
  opts: { asOf?: Date } = {},
): ClusterTask[] {
  const byTask = new Map<string, ReplaySession[]>();
  for (const s of sessions) {
    if (!s.taskId) continue;
    (byTask.get(s.taskId) ?? byTask.set(s.taskId, []).get(s.taskId)!).push(s);
  }
  const out: ClusterTask[] = [];
  for (const t of all) {
    if (opts.asOf && t.createdAt.getTime() >= opts.asOf.getTime()) continue;
    const actual = actualOf(byTask.get(t.id) ?? []);
    if (actual.minutes <= 0) continue;
    out.push({
      id: t.id,
      createdAt: t.createdAt,
      kind: t.kind ?? null,
      complexity: t.complexity ?? null,
      minutes: actual.minutes,
      tokens: actual.tokens,
      repairs: repairsByTask.get(t.id) ?? 0,
      files: filesByTask.get(t.id) ?? [],
    });
  }
  return out;
}

/** Retry attempts (CI / conflict / review) that hang off each work task. */
export async function loadRepairCounts(taskIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < taskIds.length; i += 500) {
    const rows = await db
      .select({ parent: tasks.parentTaskId, n: count() })
      .from(tasks)
      .where(and(eq(tasks.taskClass, 'attempt'), isNotNull(tasks.parentTaskId), inArray(tasks.parentTaskId, taskIds.slice(i, i + 500) as string[])))
      .groupBy(tasks.parentTaskId);
    for (const r of rows) if (r.parent) out.set(r.parent, Number(r.n));
  }
  return out;
}

/** Files each task's merged PR touched (the ingested diff chunks). */
export async function loadDiffFiles(all: readonly ReplayTask[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const byWorkspace = new Map<string, string[]>();
  for (const t of all) (byWorkspace.get(t.workspaceId) ?? byWorkspace.set(t.workspaceId, []).get(t.workspaceId)!).push(t.id);
  const config = { ...TASK_AREA_FALLBACK, pathSource: 'diff' as const };
  for (const [workspaceId, ids] of byWorkspace) {
    for (let i = 0; i < ids.length; i += 500) {
      const part = await fetchNeighbourPaths(ids.slice(i, i + 500), { workspaceId, config });
      for (const [id, files] of part) out.set(id, files);
    }
  }
  return out;
}

export async function loadClusterInput(opts: { workspaceId?: string; asOf?: Date } = {}) {
  const input = await loadReplayInput({ workspaceId: opts.workspaceId });
  const [files, repairs] = await Promise.all([loadDiffFiles(input.tasks), loadRepairCounts(input.tasks.map(t => t.id))]);
  return {
    ...input,
    clusterTasks: buildClusterTasks(input.tasks, input.sessions, files, repairs, { asOf: opts.asOf }),
  };
}
