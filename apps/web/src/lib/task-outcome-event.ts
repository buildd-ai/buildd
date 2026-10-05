/**
 * The outcome event for a task whose release the worker PATCH held for CI.
 *
 * The PATCH emits no `task.completed` / `task.failed` while the release waits
 * on its PR's CI: the task is not done yet. When the release PR's CI settles
 * it (GitHub webhook, `handleReleasePrCiSuccess` / `handleReleasePrCiFailure`),
 * this emits the one outcome event the task gets, `via: 'release'`, with the
 * same shape the PATCH would have built. Core: it reads the task, its
 * workspace and its latest worker, and emits; it names no module.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import { emit } from '@/lib/core-emit';
import type { SlotFailure } from '@/lib/core-events';

/** `failure` null: the release landed and the task completed. Never throws. */
export async function emitHeldReleaseOutcome(taskId: string, failure: SlotFailure | null): Promise<void> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { id: true, title: true, workspaceId: true },
      with: { workspace: { columns: { name: true, teamId: true, dataClass: true } } },
    });
    const workspace = task?.workspace as { name?: string | null; teamId?: string | null; dataClass?: string | null } | null | undefined;
    if (!task || !workspace?.teamId) return;
    // The worker whose completion the release was held for: the task's latest.
    const [worker] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.taskId, taskId))
      .orderBy(desc(workers.createdAt))
      .limit(1);
    if (!worker) {
      console.warn(`[release-pr] Task ${taskId} settled with no worker row; no outcome event`);
      return;
    }
    await emit({
      type: failure ? 'task.failed' : 'task.completed',
      via: 'release',
      taskId,
      workerId: worker.id,
      workspaceId: task.workspaceId,
      title: task.title,
      sensitive: workspace.dataClass === 'sensitive',
      teamId: workspace.teamId,
      workspaceName: workspace.name ?? null,
      error: null,
      failure,
    });
  } catch (err) {
    console.error(`[release-pr] Outcome event for task ${taskId} failed:`, err);
  }
}
