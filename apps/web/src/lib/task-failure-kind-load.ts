import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { isSurfaceAuditTask } from '@buildd/core/surface-audit';
import { classifyTaskFailure, failedDependencyOf, type TaskFailureKind } from './task-failure-kind';
import { sqlExtras, sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';

export interface TaskFailure {
  kind: TaskFailureKind | null;
  /** For `dependency`: the failed task it waits on, where the recovery is. */
  waitingOn: { taskId: string; title: string | null } | null;
}

/**
 * The failure kind of one task, read against the rest of its mission. Only a
 * failed task in a mission can be a verification or dependency failure, so
 * anything else costs no query.
 */
export async function loadTaskFailure(task: { id: string; title: string; status: string; missionId: string | null }): Promise<TaskFailure> {
  if (task.status !== 'failed') return { kind: null, waitingOn: null };
  if (!task.missionId) return { kind: 'execution', waitingOn: null };
  const rows = await db.query.tasks.findMany({
    where: sqlWhere(eq(tasks.missionId, task.missionId)),
    columns: { id: true, title: true, status: true },
    // The three `result` keys `dependencyFailureOf` reads, never the whole result.
    extras: sqlExtras({
      result: sql<Record<string, unknown> | null>`jsonb_build_object('errorType', ${tasks.result} -> 'errorType', 'blockedBy', ${tasks.result} -> 'blockedBy', 'error', left(${tasks.result} ->> 'error', 500))`.as('result'),
    }),
    with: {
      workers: {
        columns: { status: true, prUrl: true, mergedAt: true, prLifecycleStatus: true },
        orderBy: sqlOrderByFn((w, { desc }) => desc(w.createdAt)),
        limit: 1,
      },
    },
  });
  const self = rows.find(r => r.id === task.id) ?? { ...task, workers: [] };
  return { kind: classifyTaskFailure(self, rows), waitingOn: failedDependencyOf(self, rows) };
}

export async function loadTaskFailureKind(task: { id: string; title: string; status: string; missionId: string | null }): Promise<TaskFailureKind | null> {
  return (await loadTaskFailure(task)).kind;
}

/** The audit task id the verification card retries: this task, when it is itself a surface audit. */
export function auditTaskIdFor(task: { id: string; title: string }, kind: TaskFailureKind | null): string | null {
  return kind === 'verification' && isSurfaceAuditTask(task.title) ? task.id : null;
}
