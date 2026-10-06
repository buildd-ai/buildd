import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { isSurfaceAuditTask } from '@buildd/core/surface-audit';
import { classifyTaskFailure, type TaskFailureKind } from './task-failure-kind';

/**
 * The failure kind of one task, read against the rest of its mission. Only a
 * failed task in a mission can be a verification failure, so anything else
 * costs no query.
 */
export async function loadTaskFailureKind(task: { id: string; title: string; status: string; missionId: string | null }): Promise<TaskFailureKind | null> {
  if (task.status !== 'failed') return null;
  if (!task.missionId) return 'execution';
  const rows = await db.query.tasks.findMany({
    where: eq(tasks.missionId, task.missionId),
    columns: { id: true, title: true, status: true },
    with: {
      workers: {
        columns: { status: true, prUrl: true, mergedAt: true, prLifecycleStatus: true },
        orderBy: (w, { desc }) => desc(w.createdAt),
        limit: 1,
      },
    },
  });
  const self = rows.find(r => r.id === task.id) ?? { ...task, workers: [] };
  return classifyTaskFailure(self, rows);
}

/** The audit task id the verification card retries: this task, when it is itself a surface audit. */
export function auditTaskIdFor(task: { id: string; title: string }, kind: TaskFailureKind | null): string | null {
  return kind === 'verification' && isSurfaceAuditTask(task.title) ? task.id : null;
}
