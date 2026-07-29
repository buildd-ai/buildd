/**
 * Reconciliation sweep for task subject anchors.
 *
 * On PR closed/merged webhook events and on retry-chain completion, sweep every
 * task anchored to the PR and every retry-chain member, persisting
 * subjectResolution when the subject is determined to be dead (no live
 * successor PR in the chain). Idempotent — re-running on already-reconciled
 * tasks is a no-op.
 */

import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';

export interface SubjectSweepResult {
  anchored: number;
  reconciled: number;
}

const DEAD_LIFECYCLE_STATUSES = new Set(['closed', 'merged']);
const CLAIMABLE_STATUSES = new Set(['pending', 'assigned']);

/**
 * Sweep all tasks anchored to the given PR, marking them as `subjectResolution
 * = 'reconciled'` when no live worker PR remains in the retry chain.
 *
 * Safe to call multiple times (idempotent): tasks already marked reconciled or
 * not in a claimable status are skipped. Never touches completed/failed/
 * cancelled tasks.
 */
export async function sweepSubjectAnchoredTasks(
  workspaceId: string,
  prNumber: number,
): Promise<SubjectSweepResult> {
  // Step 1: find all tasks directly anchored to this PR
  const anchored = await db.query.tasks.findMany({
    where: and(
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.subjectPrNumber, prNumber),
    ),
    columns: { id: true, status: true, parentTaskId: true, subjectResolution: true },
  });

  if (anchored.length === 0) {
    return { anchored: 0, reconciled: 0 };
  }

  // Step 2: expand to retry-chain members by following parentTaskId edges
  const taskIds = new Set(anchored.map(t => t.id));
  const parentIds = anchored.map(t => t.parentTaskId).filter(Boolean) as string[];

  if (parentIds.length > 0) {
    // Fetch parent tasks
    const parents = await db.query.tasks.findMany({
      where: inArray(tasks.id, parentIds),
      columns: { id: true, status: true },
    });
    for (const p of parents) taskIds.add(p.id);

    // Fetch sibling tasks (other children of the same parents)
    const siblings = await db.query.tasks.findMany({
      where: inArray(tasks.parentTaskId, parentIds),
      columns: { id: true, status: true },
    });
    for (const s of siblings) taskIds.add(s.id);
  }

  // Step 3: check whether any retry-chain member has a live (not dead) worker PR.
  // A "live" worker PR has a prLifecycleStatus that is not closed/merged.
  // Workers with null prLifecycleStatus (no PR yet) are NOT considered live for
  // this purpose — only workers with a confirmed open/running/green PR block.
  const chainWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.taskId, [...taskIds]),
      isNotNull(workers.prNumber),
      isNotNull(workers.prLifecycleStatus),
    ),
    columns: { taskId: true, prLifecycleStatus: true },
  });

  const hasLiveSuccessorPr = chainWorkers.some(
    w => w.prLifecycleStatus !== null && !DEAD_LIFECYCLE_STATUSES.has(w.prLifecycleStatus),
  );

  if (hasLiveSuccessorPr) {
    // A chain member has a live PR — the subject is still being worked on
    return { anchored: taskIds.size, reconciled: 0 };
  }

  // Step 4: collect anchored tasks that are claimable and not yet reconciled
  const toReconcile = anchored.filter(
    t => CLAIMABLE_STATUSES.has(t.status) && t.subjectResolution !== 'reconciled',
  );

  if (toReconcile.length === 0) {
    return { anchored: taskIds.size, reconciled: 0 };
  }

  // Step 5: mark them reconciled (idempotent via the filter above)
  await db.update(tasks).set({
    subjectResolution: 'reconciled',
    updatedAt: new Date(),
  }).where(inArray(tasks.id, toReconcile.map(t => t.id)));

  return { anchored: taskIds.size, reconciled: toReconcile.length };
}
