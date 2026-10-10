/**
 * The admin app's Usage page names the most expensive tasks. The usage rollup
 * (lib/usage-stats.ts) aggregates per group, not per task, so this ranks the
 * same scanned worker rows by task.
 */
export interface TaskCostRow { taskId: string | null; costUsd: string | number | null; workspaceId: string }
export interface RankedTask { taskId: string; workspaceId: string; costUsd: number; workers: number }

export function rankTopTasks(rows: TaskCostRow[], limit: number): RankedTask[] {
  const byTask = new Map<string, RankedTask>();
  for (const r of rows) {
    if (!r.taskId || r.costUsd == null) continue;
    const t = byTask.get(r.taskId) ?? { taskId: r.taskId, workspaceId: r.workspaceId, costUsd: 0, workers: 0 };
    t.costUsd += Number(r.costUsd);
    t.workers += 1;
    byTask.set(r.taskId, t);
  }
  return [...byTask.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, limit);
}
