/**
 * One read of a task's workers and open question, shared by the task page
 * (/app/tasks/[id]) and the sheet (/api/tasks/[id]/summary), so both show the
 * same worker and the same question for the same task.
 *
 * The pick itself, `pickTaskView`, is pure and lives in lib/task-view-pick.ts
 * so the mission board uses it too.
 */
import { db } from '@buildd/core/db';
import { workers, missionNotes } from '@buildd/core/db/schema';
import { and, asc, desc, eq } from 'drizzle-orm';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { pickTaskView } from '@/lib/task-view-pick';
import { loadTaskRecoveryViewsForViewer } from '@/lib/incident-recovery-load';
import type { TaskRecoveryView } from '@/lib/incident-recovery-refs';

export { pickTaskView } from '@/lib/task-view-pick';

/** Worker columns the task page and the sheet never read (excluded, so a new column is read by default). */
export const TASK_VIEW_UNREAD_WORKER_COLUMNS = { mcpCalls: false, verificationEvidence: false, subagentSpans: false, degradedConnectors: false } as const;

/** The task's workers (with their account) and its open question notes: two statements a caller may batch with its own. */
export function taskViewReads(taskId: string) {
  return [
    db.query.workers.findMany({
      where: sqlWhere(eq(workers.taskId, taskId)),
      // Every column either surface reads; not the per-call MCP log, verification
      // evidence, subagent spans or degraded connectors, which neither shows.
      columns: TASK_VIEW_UNREAD_WORKER_COLUMNS,
      orderBy: sqlOrderBy([desc(workers.createdAt), desc(workers.id)]),
      with: { account: { columns: { name: true, authType: true } } },
    }),
    db.query.missionNotes.findMany({
      where: sqlWhere(and(
        eq(missionNotes.taskId, taskId),
        eq(missionNotes.type, 'question'),
        eq(missionNotes.status, 'open'),
      )),
      orderBy: sqlOrderBy(asc(missionNotes.createdAt)),
      columns: { id: true, workerId: true, type: true, status: true, title: true, body: true, defaultChoice: true, createdAt: true },
    }),
  ] as const;
}

/**
 * Any failure recovery holding the task. A completed task is held by none
 * (recovery owns a failed task's next step), so it reads nothing.
 */
export async function loadTaskViewRecovery(
  task: { id: string; status: string },
  viewer: { userId: string | null; teamId: string | null },
): Promise<TaskRecoveryView | null> {
  if (task.status === 'completed') return null;
  return (await loadTaskRecoveryViewsForViewer([task.id], viewer)).get(task.id) ?? null;
}

/**
 * The task's workers, its open question notes and any recovery holding it,
 * read in one wait (the two reads in one batch), then picked by `pickTaskView`.
 * Call it after the access check: it reads the task's workers.
 */
export async function loadTaskView(
  task: { id: string; status: string },
  viewer: { userId: string | null; teamId: string | null },
) {
  const [[workerRows, openQuestions], recovery] = await Promise.all([
    db.batch(taskViewReads(task.id)),
    loadTaskViewRecovery(task, viewer),
  ]);
  return pickTaskView({ task, workers: workerRows ?? [], openQuestions: openQuestions ?? [], recovery });
}

export type TaskView = Awaited<ReturnType<typeof loadTaskView>>;
