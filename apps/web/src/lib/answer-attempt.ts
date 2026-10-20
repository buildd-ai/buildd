/**
 * A cold answer is a new attempt of the SAME task.
 *
 * When an answered question cannot resume its parked session (a gate failed,
 * the runner never acknowledged it, the interactive session never read it),
 * the work does not move to a new task. The answered worker is superseded by
 * its caller, and this reopens that worker's own task for the next claim, which
 * mints a new worker row under the same task id: one task, one mission slot,
 * one dependency node, with the answer carried in `context.answeredQuestions`.
 *
 * The single writer `/respond` and both answer sweeps share, so the three
 * cannot drift into reopening the same event differently.
 * See docs/specs/answered-question-resume.md, "The cold fallback".
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { FORCE_CLAIM_CONTEXT_KEY } from '@/lib/force-claim';
import { requeueBranchContext } from '@/lib/integration-refresh';
import {
  REOPENABLE_TASK_STATUSES,
  buildAnsweredAttemptContextPatch,
  buildAnsweredQuestionEntry,
  isReopenableTaskStatus,
  type AnswerDeliveryRecord,
} from '@/lib/answer-resume';

type MilestoneLike = { type?: string; label?: string; timestamp?: number };

export type ReopenForAnswerResult =
  | { reopened: true; taskId: string; entryId: string }
  | {
      reopened: false;
      /**
       * - `task_missing`: no such task.
       * - `task_closed`: it is completed or cancelled; an answer never reopens it.
       * - `not_reopenable`: the guarded write moved nothing (it closed, was merged,
       *   or another attempt went live in the window).
       * - `kernel_refused`: a delivery owner whose requeue/reopen the kernel did not make.
       */
      reason: 'task_missing' | 'task_closed' | 'not_reopenable' | 'kernel_refused';
    };

/**
 * Reopen the answered worker's own task for a new attempt carrying the answer.
 *
 * The caller has already superseded the worker (its CAS on the question is what
 * decides between two answers). A thrown error is the caller's to compensate:
 * nothing here has moved the task unless it returns `reopened: true`.
 */
export async function reopenTaskForAnsweredAttempt(input: {
  taskId: string;
  /** The superseded attempt. `completedAt` is the end its supersede wrote. */
  worker: { id: string; branch: string | null; lastCommitSha?: string | null; completedAt: Date | string | null };
  milestones: MilestoneLike[];
  question: string;
  answer: string;
  /** The cold decision, as recorded on `answerDelivery`. */
  delivery: AnswerDeliveryRecord;
  /** Who reopened it, for the kernel's actor: `respond`, `sweep:…`. */
  source: string;
}): Promise<ReopenForAnswerResult> {
  // Workflow modules load lazily, as everywhere else on the answer path: this
  // file is imported by /respond and the sweeps, and their static graph split
  // into a chunk Turbopack then named the same as an unrelated loader chunk.
  const [{ notKernelMergedTaskSql }, { endedAtOf, isOwnerTask, notOwnerTaskSql, reopenOwner, requeueOwner }] = await Promise.all([
    import('@/lib/workflow/pr-fact-scope'),
    import('@/lib/workflow/owner-attempt'),
  ]);
  const task = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, input.taskId)),
    columns: { id: true, workspaceId: true, status: true, context: true, deliveryId: true, deliveryRole: true },
  });
  if (!task) return { reopened: false, reason: 'task_missing' };
  if (!isReopenableTaskStatus(task.status)) return { reopened: false, reason: 'task_closed' };

  const entry = buildAnsweredQuestionEntry({
    workerId: input.worker.id,
    question: input.question,
    answer: input.answer,
    milestones: input.milestones,
    branch: input.worker.branch,
    delivery: input.delivery,
  });
  const patch = buildAnsweredAttemptContextPatch({
    context: task.context,
    entry,
    branchContext: requeueBranchContext(task.context, input.worker.branch),
    lastCommitSha: input.worker.lastCommitSha ?? null,
    delivery: input.delivery,
  });
  // Merged into the LIVE context in SQL, never a spread of the read above: a
  // worker message or another writer may have touched it since. A force-claim
  // audit describes one claim and never survives a requeue.
  const context = sql`(COALESCE(${tasks.context}, '{}'::jsonb) - ${FORCE_CLAIM_CONTEXT_KEY}::text) || ${JSON.stringify(patch)}::jsonb`;
  // Another attempt already live on this task carries the work; this answer
  // must not pull the task out from under it.
  const noOtherLiveAttempt = sql`NOT EXISTS (SELECT 1 FROM workers ow WHERE ow.task_id = ${tasks.id} AND ow.id <> ${input.worker.id}::uuid AND ow.status IN (${sql.join(LIVE_WORKER_STATUSES.map(s => sql`${s}`), sql`, `)}))`;
  const open = inArray(tasks.status, [...REOPENABLE_TASK_STATUSES]);

  if (!isOwnerTask(task)) {
    // The same requeue every retry writes: pending, unclaimed, so the claim
    // route schedules the new attempt like any queued task.
    const [row] = await db
      .update(tasks)
      .set({
        status: 'pending',
        claimedBy: null,
        claimedAt: null,
        expiresAt: null,
        context: context as any,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, task.id), open, notKernelMergedTaskSql(), notOwnerTaskSql(), noOtherLiveAttempt))
      .returning({ id: tasks.id });
    return row ? { reopened: true, taskId: task.id, entryId: entry.id } : { reopened: false, reason: 'not_reopenable' };
  }

  // A delivery owner: its status is the kernel's. Write the answer first (the
  // new attempt reads it at claim), then ask the kernel to move the task.
  const [written] = await db
    .update(tasks)
    .set({ context: context as any, updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), open, notKernelMergedTaskSql(), noOtherLiveAttempt))
    .returning({ id: tasks.id });
  if (!written) return { reopened: false, reason: 'not_reopenable' };

  const { systemPrincipal } = await import('@/lib/workflow/kernel-client');
  const ownerTask = { id: task.id, workspaceId: task.workspaceId, deliveryId: task.deliveryId!, deliveryRole: 'owner' as const, context: task.context };
  const principal = systemPrincipal(`system:${input.source}`);
  const moved = task.status === 'failed'
    ? await reopenOwner({ task: ownerTask, workerId: input.worker.id, endedAt: endedAtOf(input.worker.completedAt), to: 'pending', reason: 'answered_new_attempt', source: input.source, principal })
    : await requeueOwner({ task: ownerTask, workerId: input.worker.id, reason: 'answered_new_attempt', source: input.source, principal });
  if (moved) return { reopened: true, taskId: task.id, entryId: entry.id };

  // The kernel kept the task where it was: take back the answer this attempt
  // will never run with, so a later attempt is not told it was given.
  await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), '{answeredQuestions}', COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(COALESCE(${tasks.context}->'answeredQuestions', '[]'::jsonb)) e WHERE e->>'id' <> ${entry.id}), '[]'::jsonb))` as any,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, task.id));
  return { reopened: false, reason: 'kernel_refused' };
}
