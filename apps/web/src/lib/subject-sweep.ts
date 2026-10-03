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

import { reconcileSubjectEvent } from './supersession';

export interface SubjectSweepResult {
  anchored: number;
  /** Tasks stamped subjectResolution = 'reconciled' by this run. */
  reconciled: number;
  /** Tasks terminated (status -> 'cancelled') by this run. Same set as reconciled. */
  cancelled: number;
}

/**
 * Sweep all tasks anchored to the given PR: when no live worker PR remains in
 * the retry chain, pending/assigned binding-anchored tasks are cancelled and
 * stamped `reconciled` so they fall out of the claim queue and
 * mission-completion counts.
 *
 * Now the `close_reconciles_subject` rule of the supersession table, run as a
 * `subject_check` event — the cancel goes through the reconciler's CAS and
 * ledger. Kept as an entry point for the doors that re-check a subject without
 * having observed a close themselves (retry completion, the hourly reconcile,
 * dead-PR shutdown). Idempotent.
 */
export async function sweepSubjectAnchoredTasks(
  workspaceId: string,
  prNumber: number,
): Promise<SubjectSweepResult> {
  const result = await reconcileSubjectEvent(
    { kind: 'subject_check', workspaceId, prNumber, door: 'sweepSubjectAnchoredTasks' },
    { rules: ['close_reconciles_subject'] },
  );
  return {
    anchored: result.decisions.length,
    reconciled: result.cancelled.length,
    cancelled: result.cancelled.length,
  };
}
