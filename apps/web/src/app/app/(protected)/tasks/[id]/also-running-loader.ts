/**
 * Loads the task page's "Also running" workers with the task's own lineage
 * already removed (see `also-running.ts`). Runs inside the page's single
 * `Promise.all`, so the parent-chain walk is not a serial wait on the render.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { isInTaskLineage, unresolvedParentIds } from './also-running';

/** Parent-chain lookups past this depth are not worth a render round trip. */
const MAX_LINEAGE_ROUNDS = 6;

export async function loadAlsoRunningWorkers(opts: {
  task: { id: string; workspaceId: string; parentTaskId: string | null; parentTask?: { parentTaskId: string | null } | null };
  liveStatuses: string[];
}) {
  const { task } = opts;
  const rows = await db.query.workers.findMany({
    where: and(eq(workers.workspaceId, task.workspaceId), inArray(workers.status, opts.liveStatuses), ne(workers.taskId, task.id)),
    columns: { id: true, taskId: true, status: true, milestones: true },
    with: { task: { columns: { id: true, title: true, label: true, missionId: true, parentTaskId: true } } },
    orderBy: desc(workers.updatedAt),
    limit: 12,
  });

  const parentOf = new Map<string, string | null>([[task.id, task.parentTaskId ?? null]]);
  if (task.parentTaskId && task.parentTask) parentOf.set(task.parentTaskId, task.parentTask.parentTaskId ?? null);
  for (const w of rows) if (w.task) parentOf.set(w.task.id, w.task.parentTaskId ?? null);
  for (let round = 0; round < MAX_LINEAGE_ROUNDS; round++) {
    const missing = unresolvedParentIds(parentOf);
    if (missing.length === 0) break;
    const parents = await db.query.tasks.findMany({
      where: inArray(tasks.id, missing),
      columns: { id: true, parentTaskId: true },
    });
    for (const id of missing) parentOf.set(id, null);
    for (const r of parents) parentOf.set(r.id, r.parentTaskId ?? null);
  }

  return rows.filter(w => !w.task || !isInTaskLineage(w.task.id, task.id, parentOf));
}
