/**
 * Reconciliation sweep for task subject anchors.
 *
 * On PR closed/merged webhook events and on retry-chain completion, sweep every
 * task anchored to the PR and every retry-chain member. When the subject is
 * determined to be dead (no live successor PR in the chain) the anchored task is
 * both marked `subjectResolution = 'reconciled'` AND terminated
 * (`status = 'cancelled'`). Idempotent — re-running on already-reconciled tasks
 * is a no-op.
 *
 * WHY TERMINATE INSTEAD OF LEAVING IT PENDING:
 * A reconciled task is permanently unclaimable (see api/workers/claim/
 * subject-gate.ts) yet used to advertise itself as `pending` — a queued row that
 * can never run. Worse, `deps-gate.ts` only treats a dependency as satisfied
 * when it is `completed` (PR merged) or `cancelled`, so a pending-but-dead task
 * starved every dependent behind it until a human intervened (the 5-day,
 * 20-task stall). `cancelled` is the dep gate's designed escape hatch —
 * "this won't be delivered, proceed" — so terminating drains the chain.
 *
 * ONLY THE IDENTIFYING ANCHOR CLASS IS ELIGIBLE:
 * Reconciliation (and therefore termination) applies only to anchors whose
 * `source` is in SUBJECT_BINDING_SOURCES (system | context, confidence exact).
 * A PR number scraped from prose (`source: 'text' | 'url'`) is advisory: it must
 * never gate a claim and must never cancel a task. Auto-cancelling that class
 * would be strictly worse than the original bug.
 */

import { db } from '@buildd/core/db';
import { tasks, taskSubjectReports, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { isBindingSubjectAnchor } from './subject-gate-contract';

export interface SubjectSweepResult {
  anchored: number;
  /** Tasks stamped subjectResolution = 'reconciled' by this run. */
  reconciled: number;
  /** Tasks terminated (status -> 'cancelled') by this run. Same set as reconciled. */
  cancelled: number;
}

const DEAD_LIFECYCLE_STATUSES = new Set(['closed', 'merged']);
const CLAIMABLE_STATUSES = new Set(['pending', 'assigned']);

/**
 * Sweep all tasks anchored to the given PR. When no live worker PR remains in
 * the retry chain, pending/assigned tasks are CANCELLED (not just marked
 * reconciled) so they fall out of the claim queue and mission-completion counts.
 *
 * The claim route's SQL pre-filter (subjectLivenessCondition) already excludes
 * tasks with subjectResolution='reconciled', so a task that is only marked
 * reconciled but stays 'pending' becomes permanently invisible to the claim loop
 * while still blocking countPendingTasksForMission — the "stranded pending" bug.
 * Cancellation is the correct terminal state: there is nothing left to fix on a
 * dead PR.
 *
 * Safe to call multiple times (idempotent): tasks already cancelled/completed/
 * failed or already marked reconciled are not touched.
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
    // subjectAnchor carries `source` — there is no relational projection of it,
    // so it MUST be selected. An unselected column reads as undefined, which the
    // contract treats as advisory (fail open): the sweep would then stop
    // reconciling anything rather than silently cancel the wrong tasks.
    columns: {
      id: true,
      status: true,
      parentTaskId: true,
      subjectResolution: true,
      subjectAnchor: true,
    },
  });

  if (anchored.length === 0) {
    return { anchored: 0, reconciled: 0, cancelled: 0 };
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
    return { anchored: taskIds.size, reconciled: 0, cancelled: 0 };
  }

  // Step 4: collect anchored tasks that are claimable, not yet reconciled, and
  // whose anchor actually identifies the subject. Advisory anchors are left
  // completely untouched — that means BOTH a non-binding source (text/url) and a
  // binding source carrying `confidence: 'derived'` (an unverified caller-supplied
  // hint). This MUST be the same predicate the claim gate and /start use: if the
  // sweep classified more broadly than the gate, it would cancel a task that the
  // gate considers perfectly claimable — trading a silent stall for silent
  // destruction, which is strictly worse.
  const toReconcile = anchored.filter(
    t => CLAIMABLE_STATUSES.has(t.status)
      && t.subjectResolution !== 'reconciled'
      && isBindingSubjectAnchor(t.subjectAnchor),
  );

  if (toReconcile.length === 0) {
    return { anchored: taskIds.size, reconciled: 0, cancelled: 0 };
  }

  // Step 5: mark them reconciled AND terminate them.
  //
  // We cancel (not just mark reconciled) for two reinforcing reasons:
  //
  //  1. The claim route's SQL pre-filter (subjectLivenessCondition) excludes
  //     tasks where subjectResolution='reconciled'. A task that is only marked
  //     reconciled but stays 'pending' becomes permanently invisible to the
  //     claim loop while still counting against queue depth and
  //     mission-completion gates (countPendingTasksForMission counts by status,
  //     not subjectResolution). This was the root cause of session-limit-deferred
  //     CI-retry tasks stranding for weeks: the budget-reset startAt passed, but
  //     the task was never re-claimed because the SQL filter hid it entirely.
  //  2. `cancelled` is the dependency gate's satisfying status, so terminating a
  //     dead task is also what stops it starving its dependents. Leaving it
  //     pending is how one dead task stalled a 20-task chain.
  //
  // The status guard in the WHERE keeps the write race-safe: a task that a
  // worker picked up between the read above and this write is no longer in a
  // claimable status and is left alone. RETURNING tells us which rows actually
  // changed, so the counts, the log line and the audit trail below describe
  // reality rather than intent.
  const terminated = await db.update(tasks).set({
    subjectResolution: 'reconciled',
    status: 'cancelled',
    updatedAt: new Date(),
  }).where(and(
    inArray(tasks.id, toReconcile.map(t => t.id)),
    inArray(tasks.status, [...CLAIMABLE_STATUSES]),
  )).returning({ id: tasks.id });

  console.log(
    `[subject-sweep] PR #${prNumber} (workspace ${workspaceId}): cancelled ${terminated.length} pending task(s) whose subject PR has no live successor.`,
    terminated.map(row => row.id),
  );

  // Step 6: audit trail. taskSubjectReports is the existing per-task subject
  // ledger (append-only, anchor snapshot included), so "why was this cancelled,
  // which PR, when" stays legible after the fact without a new column.
  const anchorById = new Map(toReconcile.map(t => [t.id, t.subjectAnchor ?? null]));
  if (terminated.length > 0) {
    try {
      await db.insert(taskSubjectReports).values(
        terminated.map(row => ({
          taskId: row.id,
          origin: 'system',
          note: `subject_reconciled: PR #${prNumber} is dead (closed/merged, no live successor) — task cancelled so dependents unblock`,
          anchorSnapshot: anchorById.get(row.id) ?? null,
        })),
      );
    } catch (error) {
      // Never fail the sweep over its own audit trail.
      console.error('[subject-sweep] failed to persist reconciliation audit rows:', error);
    }
  }

  return {
    anchored: taskIds.size,
    reconciled: terminated.length,
    cancelled: terminated.length,
  };
}
