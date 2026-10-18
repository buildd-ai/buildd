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
import { sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';
import { NON_RUNNER_EXECUTOR_IDS } from '@/lib/executor';

/**
 * AC-1 slice 8 (docs/specs/workflow-kernel-library.md §9): the kernel delivery a loop task owns, or
 * null. A loop's exit writes the loop fields either way; the owner task's status is the kernel's:
 * a merge completes it in T17's own statement, and a green-checks exit settles the held attempt
 * (`settleKernelLoopExit`). A delivery the kill switch released is legacy again.
 */
async function kernelOwnerDelivery(task: { deliveryId?: string | null; deliveryRole?: string | null }): Promise<string | null> {
  if (!task.deliveryId || task.deliveryRole !== 'owner') return null;
  const { kernelDeliveryById } = await import('@/lib/workflow/authority');
  return kernelDeliveryById(task.deliveryId).catch(() => null);
}

/**
 * The green-checks exit of a kernel owner's loop: the loop parked the task in the queue when its
 * attempt ended, and the kernel recorded that end. The exit re-sends it for the task's latest
 * attempt (AttemptEnded through the kernel client: a duplicate when recorded, the end itself when
 * it never arrived), then completes the parked task under the projection's guard
 * (`projectLoopExit`: still pending, the loop satisfied, no live attempt). Never throws.
 */
async function settleKernelLoopExit(p: { taskId: string; workspaceId: string; deliveryId: string; context: unknown }): Promise<boolean> {
  try {
    // The latest attempt row: a placeholder no runner executed (a second PR's sibling row) is none.
    const rows = await db.query.workers.findMany({
      where: sqlWhere(eq(workers.taskId, p.taskId)),
      columns: { id: true, status: true, runner: true, lastCommitSha: true, commitCount: true },
      orderBy: sqlOrderByFn((wk, { desc }) => [desc(wk.createdAt), desc(wk.id)]),
      limit: 10,
    });
    const latest = rows.find((r) => !r.runner || !(NON_RUNNER_EXECUTOR_IDS as readonly string[]).includes(r.runner));
    const { attemptEnded, systemPrincipal } = await import('@/lib/workflow/kernel-client');
    if (latest?.status === 'completed') {
      await attemptEnded({
        task: { id: p.taskId, workspaceId: p.workspaceId, deliveryId: p.deliveryId, deliveryRole: 'owner', context: p.context },
        workerId: latest.id,
        status: 'completed',
        localHeadSha: latest.lastCommitSha ?? null,
        commitCount: latest.commitCount ?? 0,
        source: 'webhook:loop_exit',
      }, { principal: systemPrincipal('system:loop-exit') }).catch((err) => console.error(`[loop-webhook] AttemptEnded for the loop exit of task ${p.taskId} failed:`, err));
    }
    const { projectLoopExit } = await import('@/lib/workflow/seam');
    return await projectLoopExit({ deliveryId: p.deliveryId, taskId: p.taskId });
  } catch (err) {
    console.error(`[loop-webhook] loop exit of kernel owner task ${p.taskId} not settled:`, err);
    return false;
  }
}

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
    where: sqlWhere(eq(tasks.id, taskId)),
    columns: {
      loopConfig: true,
      loopIteration: true,
      loopState: true,
      context: true,
      startAt: true,
      status: true,
      workspaceId: true,
      deliveryId: true,
      deliveryRole: true,
    },
  });

  if (!task) return false;
  if (task.loopState !== 'condition_unmet') return false;

  const loopConfig = task.loopConfig as LoopConfig | null;
  if (!loopConfig || loopConfig.exitCondition.type !== 'pr_merged') return false;

  // Fetch the worker's mergedAt (just stamped by the webhook handler)
  const worker = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.id, workerId)),
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

  // A kernel owner's merge is T17's to complete (its own statement, which already ran): the loop
  // records only that its condition held.
  const kernelDeliveryId = await kernelOwnerDelivery(task);

  // Advance the task to completed — atomic guard on loopState prevents double-fire.
  const updated = await db
    .update(tasks)
    .set({
      ...(kernelDeliveryId ? {} : { status: 'completed' as const }),
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
    where: sqlWhere(eq(tasks.id, taskId)),
    columns: {
      loopConfig: true,
      loopIteration: true,
      loopState: true,
      context: true,
      startAt: true,
      status: true,
      workspaceId: true,
      deliveryId: true,
      deliveryRole: true,
    },
  });

  if (!task) return false;
  if (task.loopState !== 'condition_unmet') return false;

  const loopConfig = task.loopConfig as LoopConfig | null;
  if (!loopConfig || loopConfig.exitCondition.type !== 'pr_checks_green') return false;

  // Fetch the worker's PR info
  const worker = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.id, workerId)),
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

  // A kernel owner's status is the kernel's: a merge completes it in T17's own statement, and a
  // green-checks exit settles the attempt the loop held (below). The loop writes its own fields.
  const kernelDeliveryId = await kernelOwnerDelivery(task);

  // Advance the task to completed — atomic guard on loopState prevents double-fire.
  const updated = await db
    .update(tasks)
    .set({
      ...(kernelDeliveryId ? {} : { status: 'completed' as const }),
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

  if (kernelDeliveryId && prLifecycleStatus !== 'merged') {
    await settleKernelLoopExit({ taskId, workspaceId: task.workspaceId ?? workspaceId, deliveryId: kernelDeliveryId, context: task.context });
  }

  await triggerEvent(channels.workspace(workspaceId), events.WORKER_PROGRESS, { taskId });
  await resolveCompletedTask(taskId, workspaceId);

  return true;
}
