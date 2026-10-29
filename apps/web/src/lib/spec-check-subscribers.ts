/**
 * Spec criterion checks on a PR head (lib/specs/criterion-checks.ts).
 *
 * - `pr.review_ready` (opened ready, or out of draft) and `pr.synchronized`
 *   (a push): file one check run per checked criterion, and one per
 *   registered `verify:` binding, of the task's pinned revision for that head.
 *   Every delivery: dispatch is idempotent per head. A registered run asks the
 *   explicit verify route, so the coordinator an explicit request and a
 *   mission's final verification use decides it; no model call holds the webhook.
 * - `worker.reported` for a check run: its exit code becomes the verdict at
 *   the head it ran on. A mission batch records one verdict per criterion, each
 *   reading the mission's target, so it waits at most BATCH_OUTCOME_BUDGET_MS
 *   and the rest finishes after the reply: the runner's completing PATCH must
 *   not time out on it. The report is stored with that completion, so a batch
 *   the request drops is settled later (`settleFinishedCheckRuns`).
 *
 * Advisory (D-5): a verdict feeds the governed outcome and blocks nothing.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { after } from 'next/server';
import { criterionBatchOf } from '@buildd/shared';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { currentPrHeadSha } from '@/lib/specs/outcome';
import { dispatchCriterionChecks, handleCriterionCheckOutcome, isCriterionCheckTask } from '@/lib/specs/criterion-checks';
import { recordLateRunnerEvidence } from '@/lib/late-runner-evidence';

export const BATCH_OUTCOME_BUDGET_MS = 5_000;

/** Wait for a batch's verdicts up to the budget; past it, keep the request alive for the rest. */
export async function awaitBatchOutcome(outcome: Promise<unknown>, taskId: string, budgetMs = BATCH_OUTCOME_BUDGET_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = outcome.then(() => true, (err) => { console.error(`[spec-checks] batch outcome for run ${taskId} failed:`, err); return true; });
  const done = await Promise.race([settled, new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), budgetMs); })]);
  clearTimeout(timer);
  if (!done) {
    try { after(() => settled.then(() => {})); } catch { /* outside a request scope: it runs on unawaited */ }
  }
}

export const specCheckSubscribers: readonly AnySubscriber[] = [
  subscriber('reviews', 'pr.review_ready', 'spec-checks-on-open', async e => {
    const headSha = e.pr.headSha ?? (await currentPrHeadSha(e.worker.taskId));
    if (!headSha) return;
    await dispatchCriterionChecks({ taskId: e.worker.taskId, headSha, headBranch: e.pr.headRef });
  }),
  subscriber('reviews', 'pr.synchronized', 'spec-checks-on-push', async e => {
    if (e.pr.draft || !e.worker.taskId) return;
    await dispatchCriterionChecks({ taskId: e.worker.taskId, headSha: e.pr.headSha, headBranch: e.worker.branch });
  }),
  // The runner's report that lands after the agent completed a verification
  // run itself: kept, and turned into the check or command-criterion verdict.
  subscriber('reviews', 'worker.late_verification_reported', 'late-runner-evidence', async e => {
    await recordLateRunnerEvidence({ workerId: e.workerId, taskId: e.taskId, evidence: e.verificationEvidence });
  }),
  subscriber('reviews', 'worker.reported', 'spec-check-outcome', async e => {
    const [row] = await db.select({ context: tasks.context }).from(tasks).where(eq(tasks.id, e.taskId)).limit(1);
    if (!isCriterionCheckTask(row?.context)) return;
    const outcome = handleCriterionCheckOutcome(e.taskId, e.verificationEvidence);
    if (criterionBatchOf(row?.context)) await awaitBatchOutcome(outcome, e.taskId);
    else await outcome;
  }),
];
