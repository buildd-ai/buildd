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

/**
 * The task's workers (with their account), its open question notes and any
 * recovery holding it, read in one wait, then picked by `pickTaskView`.
 * Call it after the access check: it reads the task's workers.
 */
export async function loadTaskView(
  task: { id: string; status: string },
  viewer: { userId: string | null; teamId: string | null },
) {
  const [workerRows, openQuestions, recoveryViews] = await Promise.all([
    db.query.workers.findMany({
      where: sqlWhere(eq(workers.taskId, task.id)),
      orderBy: sqlOrderBy([desc(workers.createdAt), desc(workers.id)]),
      with: { account: { columns: { name: true, authType: true } } },
    }),
    db.query.missionNotes.findMany({
      where: sqlWhere(and(
        eq(missionNotes.taskId, task.id),
        eq(missionNotes.type, 'question'),
        eq(missionNotes.status, 'open'),
      )),
      orderBy: sqlOrderBy(asc(missionNotes.createdAt)),
      columns: { id: true, workerId: true, type: true, status: true, title: true, body: true, defaultChoice: true, createdAt: true },
    }),
    loadTaskRecoveryViewsForViewer([task.id], viewer),
  ]);
  const recovery: TaskRecoveryView | null = recoveryViews.get(task.id) ?? null;
  return pickTaskView({ task, workers: workerRows ?? [], openQuestions: openQuestions ?? [], recovery });
}

export type TaskView = Awaited<ReturnType<typeof loadTaskView>>;
