/**
 * The other half of "recover before asking" (lib/question-gate-check.ts stage
 * 0, lib/recoverable-blocker-repair.ts): when the repair task a parked worker
 * is waiting on completes, the blocked task resumes. Without this the
 * `recovered` park sat in `waiting_input` until the 4h/24h waiting-input sweep,
 * with nothing a person could usefully answer.
 *
 * It owns no new recovery: the close is the waiting-input cleanup's own
 * `superseded_by_recovery` mode and the resume is `requeueFailedTasks`, the
 * same pair a failure incident's recovery uses
 * (failure-incident-recovery-capture.ts). A kernel delivery's owner task is
 * reopened by the kernel through that same requeue (AttemptReopened).
 *
 * The blocked task's retry is told what the repair found. When the repair
 * found the work already shipped, the retry completes with `alreadyShippedIn`,
 * which records the merged PR on the task result without adopting it onto the
 * worker (docs/specs/task-state-machine.md AC-49): the PR stays its author's.
 */

export const RECOVERABLE_BLOCKER_REPAIR_CONTEXT = 'recoverable_blocker_repair';

export function isRecoverableBlockerRepair(context: unknown): boolean {
  return (context as { type?: unknown } | null | undefined)?.type === RECOVERABLE_BLOCKER_REPAIR_CONTEXT;
}

export interface ParkedOnRepair {
  workerId: string;
  taskId: string | null;
  accountId: string | null;
}

export interface ReconcilePort {
  /** Workers still in `waiting_input` whose question is tagged with this repair (`waitingFor.repairTaskId`). */
  parkedOn(repairTaskId: string): Promise<ParkedOnRepair[]>;
  /** Record on each blocked task what the repair found, for its retry's prompt (`context.failureContext`). */
  noteRepair(taskIds: string[], failureContext: { summary: string; errorType: string }): Promise<void>;
  /** Close the questions: worker failed `superseded_by_recovery`, task failed, no clone. */
  supersede(accountId: string, workerIds: string[]): Promise<number>;
  /** Requeue the failed blocked tasks. Returns the ids requeued. */
  requeue(taskIds: string[]): Promise<string[]>;
}

/** What the retry reads as "Previous failure". */
export function repairFailureContext(repair: { id: string; summary?: string | null }): { summary: string; errorType: string } {
  const found = repair.summary?.replace(/\s+/g, ' ').trim().slice(0, 800);
  return {
    errorType: 'recoverable_blocker_repaired',
    summary: [
      `The previous attempt stopped on a platform blocker. Repair task ${repair.id.slice(0, 8)} has completed.`,
      found ? `It reported: ${found}` : null,
      'Check whether the work this task asks for is already on the base branch before redoing it. If a merged PR already delivered it, call complete_task with alreadyShippedIn set to that PR number instead of opening a new PR.',
    ].filter(Boolean).join(' '),
  };
}

/**
 * Resume every task parked on `repair`. Idempotent: a second run finds no
 * worker still in `waiting_input` on this repair, and the requeue only flips a
 * task that is `failed`.
 */
export async function reconcileBlockedOnRepair(
  port: ReconcilePort,
  repair: { id: string; summary?: string | null },
): Promise<{ closed: number; requeued: string[] }> {
  const parked = await port.parkedOn(repair.id);
  if (parked.length === 0) return { closed: 0, requeued: [] };

  const taskIds = [...new Set(parked.map(p => p.taskId).filter((t): t is string => !!t))];
  if (taskIds.length) await port.noteRepair(taskIds, repairFailureContext(repair));

  const byAccount = new Map<string, string[]>();
  for (const p of parked) if (p.accountId) byAccount.set(p.accountId, [...(byAccount.get(p.accountId) ?? []), p.workerId]);
  let closed = 0;
  for (const [accountId, workerIds] of byAccount) closed += await port.supersede(accountId, workerIds);

  const requeued = taskIds.length ? await port.requeue(taskIds) : [];
  return { closed, requeued };
}

export function dbReconcilePort(): ReconcilePort {
  return {
    async parkedOn(repairTaskId) {
      const [{ db }, { workers }, { and, eq, sql }] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm')]);
      return db.select({ workerId: workers.id, taskId: workers.taskId, accountId: workers.accountId }).from(workers)
        .where(and(eq(workers.status, 'waiting_input'), sql`${workers.waitingFor}->>'repairTaskId' = ${repairTaskId}`));
    },
    async noteRepair(taskIds, failureContext) {
      const { createDbFixTaskPort } = await import('./failure-incident-actions');
      const port = createDbFixTaskPort();
      for (const id of taskIds) await port.touch(id, { failureContext });
    },
    async supersede(accountId, workerIds) {
      const { cleanupStuckWaitingInput } = await import('./stale-workers');
      return (await cleanupStuckWaitingInput(accountId, { reason: 'superseded_by_recovery', workerIds })).failedWorkers;
    },
    async requeue(taskIds) {
      const { requeueFailedTasks } = await import('./credential-recovery');
      return requeueFailedTasks(taskIds, 'task.requeued');
    },
  };
}
