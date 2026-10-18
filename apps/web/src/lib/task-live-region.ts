/**
 * The task page's live region (spec 3ef37387 R-16): the shown worker and the
 * task's status. A live event re-reads these two rows, not the page: no task
 * view, delivery context, GitHub-cache read, notes or artifacts, which the
 * page's own render still owns.
 *
 * The read answers only when the page as rendered is still right around it:
 * the same task status, the same worker, the same question state. Anything
 * else (the task finished, a new attempt, a question arrived or was answered)
 * changes what the rest of the page shows, so it returns null and the caller
 * falls back to one page refresh.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { isLiveWorkerStatus } from '@buildd/shared';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { selectTaskWorkers } from '@/lib/attempt-order';
import { liveWorkerOf, type LiveWorkerRow } from '@/lib/task-live-view';
import type { LiveWorker } from '@/app/app/(protected)/tasks/[id]/RealTimeWorkerView';

/** What the region holds, and what a live event replaces. */
export interface TaskLiveRegion {
  taskStatus: string;
  worker: LiveWorker | null;
}

/** What the page rendered, as the read's baseline. */
export interface RenderedTaskRegion {
  taskId: string;
  taskStatus: string;
  workerId: string | null;
  hadQuestion: boolean;
}

/** Pure: the region from the two rows, or null when the page must re-render. */
export function pickTaskLiveRegion(
  task: { status: string },
  rows: readonly (LiveWorkerRow & { taskId?: string | null })[],
  rendered: RenderedTaskRegion,
): TaskLiveRegion | null {
  if (task.status !== rendered.taskStatus || !rendered.workerId) return null;
  const active = selectTaskWorkers(
    rows.map(w => ({ ...w, createdAt: w.createdAt ?? new Date(0) })),
    isLiveWorkerStatus,
  ).activeWorker;
  if (!active || active.id !== rendered.workerId) return null;
  if (!!active.waitingFor !== rendered.hadQuestion) return null;
  return { taskStatus: task.status, worker: liveWorkerOf(active) };
}

export async function loadTaskLiveRegion(viewerId: string, rendered: RenderedTaskRegion): Promise<TaskLiveRegion | null> {
  const [task, rows] = await Promise.all([
    db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, rendered.taskId)),
      columns: { status: true, workspaceId: true },
    }),
    db.query.workers.findMany({
      where: sqlWhere(eq(workers.taskId, rendered.taskId)),
      columns: {
        id: true, name: true, branch: true, status: true, currentAction: true, milestones: true,
        turns: true, costUsd: true, inputTokens: true, outputTokens: true,
        createdAt: true, startedAt: true, updatedAt: true, mergedAt: true,
        dirtyWorktree: true, observedTouches: true, prIsDraft: true,
        prUrl: true, prNumber: true, prLifecycleStatus: true,
        commitCount: true, filesChanged: true, linesAdded: true, linesRemoved: true, lastCommitSha: true,
        waitingFor: true, error: true, instructionHistory: true, pendingInstructions: true, resultMeta: true,
      },
    }),
  ]);
  if (!task?.workspaceId || !(await verifyWorkspaceAccess(viewerId, task.workspaceId))) return null;
  return pickTaskLiveRegion(task, rows as unknown as LiveWorkerRow[], rendered);
}
