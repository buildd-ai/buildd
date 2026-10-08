/**
 * The outcome event for a task whose release the worker PATCH held for CI.
 *
 * The PATCH emits no `task.completed` / `task.failed` while the release waits
 * on its PR's CI: the task is not done yet. When the release PR's CI settles
 * it (GitHub webhook, `handleReleasePrCiSuccess` / `handleReleasePrCiFailure`),
 * this emits what the PATCH held back, now that the status on the row is real:
 *   1. `task.terminal` (the evidence record reads the final status), then
 *   2. the one outcome event the task gets, `via: 'release'`, with the same
 *      shape the PATCH would have built, plus the outcome-analytics row the
 *      PATCH kept on `tasks.context.heldReleaseOutcome`.
 * Missions hear the outcome from (2) too: the PATCH's mission completion
 * attempt skips a held release. Core: it reads the task, its workspace and
 * its latest worker, and emits; it names no module.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import { emit } from '@/lib/core-emit';
import type { HeldOutcomeAnalytics, SlotFailure } from '@/lib/core-events';

function heldAnalyticsOf(context: unknown): HeldOutcomeAnalytics | null {
  const kept = (context as { heldReleaseOutcome?: unknown } | null)?.heldReleaseOutcome;
  return kept && typeof kept === 'object' ? kept as HeldOutcomeAnalytics : null;
}

/** `failure` null: the release landed and the task completed. Never throws. */
export async function emitHeldReleaseOutcome(taskId: string, failure: SlotFailure | null): Promise<void> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { id: true, title: true, workspaceId: true, missionId: true, context: true },
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
    const sensitive = workspace.dataClass === 'sensitive';
    await emit({ type: 'task.terminal', taskId, workerId: worker.id, workspaceId: task.workspaceId, sensitive });
    await emit({
      type: failure ? 'task.failed' : 'task.completed',
      via: 'release',
      taskId,
      workerId: worker.id,
      workspaceId: task.workspaceId,
      missionId: task.missionId ?? null,
      title: task.title,
      sensitive,
      teamId: workspace.teamId,
      workspaceName: workspace.name ?? null,
      error: null,
      failure,
      heldAnalytics: heldAnalyticsOf(task.context),
    });
  } catch (err) {
    console.error(`[release-pr] Outcome event for task ${taskId} failed:`, err);
  }
}
