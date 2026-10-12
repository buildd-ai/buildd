/**
 * Webhook-triggered loop advancement for pr_merged and pr_checks_green exit conditions.
 *
 * When a PR merge or check_suite webhook fires, this module evaluates whether any task
 * waiting on that PR's merge or CI checks can advance. It is the ONLY non-PATCH path
 * that may evaluate a loop condition and advance loopIteration — the
 * memory 5cb6a936 constraint is preserved (stale cleanup never evaluates).
 */

import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { dispatchLoopIteration } from '@/lib/loop-dispatcher';
import { resolveCompletedTask } from '@/lib/task-dependencies';
import { triggerEvent, channels, events } from '@/lib/pusher';
import type { LoopConfig, LoopHistoryEntry } from '@buildd/shared';

/**
 * Evaluate and advance a loop when a PR merge webhook fires.
 *
 * Finds the task associated with `workerId`, checks if it is waiting on
 * a pr_merged condition, and if the condition is now satisfied (mergedAt
 * is stamped on the worker), marks the task as completed.
 *
 * Returns true if the loop was advanced to satisfied and the task completed.
 */
export async function evaluateAndAdvanceLoopOnMerge(
  workerId: string,
  taskId: string,
  workspaceId: string,
): Promise<boolean> {
  // Fetch task loop state
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: {
      loopConfig: true,
      loopIteration: true,
      loopState: true,
      context: true,
      startAt: true,
      status: true,
    },
  });

  if (!task) return false;
  if (task.loopState !== 'condition_unmet') return false;

  const loopConfig = task.loopConfig as LoopConfig | null;
  if (!loopConfig || loopConfig.exitCondition.type !== 'pr_merged') return false;

  // Fetch the worker's mergedAt (just stamped by the webhook handler)
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    columns: { mergedAt: true, prNumber: true, branch: true, lastCommitSha: true },
  });

  if (!worker?.mergedAt) return false;

  const loopCtx = (task.context ?? {}) as Record<string, unknown>;
  const existingHistory = (loopCtx.loopHistory as LoopHistoryEntry[] | undefined) ?? [];

  const result = dispatchLoopIteration({
    loopConfig,
    currentIteration: task.loopIteration ?? 0,
    existingHistory,
    existingStartAt: task.startAt,
    workerId,
    workerBranch: worker.branch ?? null,
    workerLastCommitSha: worker.lastCommitSha ?? null,
    verificationEvidence: null,
    structuredOutput: null,
    prLifecycleStatus: 'merged',
    prNumber: worker.prNumber ?? null,
    workerMergedAt: worker.mergedAt,
  });

  if (result.kind !== 'satisfied') {
    // Shouldn't happen when mergedAt is non-null, but guard defensively.
    return false;
  }

  // Advance the task to completed — atomic guard on loopState prevents double-fire.
  const updated = await db
    .update(tasks)
    .set({
      status: 'completed',
      loopIteration: result.loopIteration,
      loopState: 'satisfied',
      result: {
        summary: worker.prNumber ? `PR #${worker.prNumber} merged` : 'PR merged',
        loopHistory: result.loopHistory,
        reaperAutoCompleted: false,
      } as any,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.loopState, 'condition_unmet')))
    .returning({ id: tasks.id });

  if (updated.length === 0) {
    // Another path already advanced this loop (concurrent webhook delivery).
    return false;
  }

  await triggerEvent(channels.workspace(workspaceId), events.WORKER_PROGRESS, { taskId });
  await resolveCompletedTask(taskId, workspaceId);

  return true;
}

/**
 * Evaluate and advance a loop when CI checks pass (check_suite webhook fires).
 *
 * Finds the task associated with `workerId`, checks if it is waiting on
 * a pr_checks_green condition, and if the condition is now satisfied
 * (prLifecycleStatus is 'ci_green' or 'merged'), marks the task as completed.
 *
 * Returns true if the loop was advanced to satisfied and the task completed.
 */
export async function evaluateAndAdvanceLoopOnCiGreen(
  workerId: string,
  taskId: string,
  workspaceId: string,
  prLifecycleStatus: string | null | undefined,
): Promise<boolean> {
  // Fetch task loop state
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: {
      loopConfig: true,
      loopIteration: true,
      loopState: true,
      context: true,
      startAt: true,
      status: true,
    },
  });

  if (!task) return false;
  if (task.loopState !== 'condition_unmet') return false;

  const loopConfig = task.loopConfig as LoopConfig | null;
  if (!loopConfig || loopConfig.exitCondition.type !== 'pr_checks_green') return false;

  // Fetch the worker's PR info
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    columns: { prNumber: true, branch: true, lastCommitSha: true },
  });

  if (!worker) return false;

  // Check if the condition is satisfied: CI checks green or PR merged
  if (prLifecycleStatus !== 'ci_green' && prLifecycleStatus !== 'merged') {
    return false;
  }

  const loopCtx = (task.context ?? {}) as Record<string, unknown>;
  const existingHistory = (loopCtx.loopHistory as LoopHistoryEntry[] | undefined) ?? [];

  const result = dispatchLoopIteration({
    loopConfig,
    currentIteration: task.loopIteration ?? 0,
    existingHistory,
    existingStartAt: task.startAt,
    workerId,
    workerBranch: worker.branch ?? null,
    workerLastCommitSha: worker.lastCommitSha ?? null,
    verificationEvidence: null,
    structuredOutput: null,
    prLifecycleStatus,
    prNumber: worker.prNumber ?? null,
  });

  if (result.kind !== 'satisfied') {
    // Shouldn't happen when prLifecycleStatus is ci_green or merged, but guard defensively.
    return false;
  }

  // Advance the task to completed — atomic guard on loopState prevents double-fire.
  const updated = await db
    .update(tasks)
    .set({
      status: 'completed',
      loopIteration: result.loopIteration,
      loopState: 'satisfied',
      result: {
        summary: worker.prNumber ? `PR #${worker.prNumber} checks green (${prLifecycleStatus})` : `Checks green (${prLifecycleStatus})`,
        loopHistory: result.loopHistory,
        reaperAutoCompleted: false,
      } as any,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.loopState, 'condition_unmet')))
    .returning({ id: tasks.id });

  if (updated.length === 0) {
    // Another path already advanced this loop (concurrent webhook delivery).
    return false;
  }

  await triggerEvent(channels.workspace(workspaceId), events.WORKER_PROGRESS, { taskId });
  await resolveCompletedTask(taskId, workspaceId);

  return true;
}
