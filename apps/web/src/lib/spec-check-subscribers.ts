/**
 * Spec criterion checks on a PR head (lib/specs/criterion-checks.ts).
 *
 * - `pr.review_ready` (opened ready, or out of draft) and `pr.synchronized`
 *   (a push): file one check run per checked criterion of the task's pinned
 *   revision for that head. Every delivery: dispatch is idempotent per head.
 * - The same two events also run the revision's registered `verify:` checks
 *   at that head (lib/specs/registered-verification.ts, the coordinator an
 *   explicit request and a mission's final verification use), on independent
 *   captures only. Its own step, after the response: a model call never holds
 *   the webhook, and a failure there never stops the command checks.
 * - `worker.reported` for a check run: its exit code becomes the verdict at
 *   the head it ran on.
 *
 * Advisory (D-5): a verdict feeds the governed outcome and blocks nothing.
 */
import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { currentPrHeadSha } from '@/lib/specs/outcome';
import { dispatchCriterionChecks, handleCriterionCheckOutcome, isCriterionCheckTask } from '@/lib/specs/criterion-checks';
import { recordLateRunnerEvidence } from '@/lib/late-runner-evidence';

/** Registered checks at `headSha` (null: the head the store resolves), after the response when a request scope exists. */
async function registeredChecks(taskId: string, headSha: string | null, source: string): Promise<void> {
  const go = () => import('@/lib/specs/registered-verification-store')
    .then(m => m.runRegisteredVerificationOnEvent(taskId, headSha, source))
    .then(() => undefined);
  try {
    after(go);
  } catch {
    await go();
  }
}

export const specCheckSubscribers: readonly AnySubscriber[] = [
  subscriber('reviews', 'pr.review_ready', 'spec-checks-on-open', async e => {
    const headSha = e.pr.headSha ?? (await currentPrHeadSha(e.worker.taskId));
    if (!headSha) return;
    await dispatchCriterionChecks({ taskId: e.worker.taskId, headSha, headBranch: e.pr.headRef });
  }),
  subscriber('reviews', 'pr.review_ready', 'registered-checks-on-open', async e => {
    await registeredChecks(e.worker.taskId, e.pr.headSha ?? null, `PR #${e.pr.number} ready`);
  }),
  subscriber('reviews', 'pr.synchronized', 'spec-checks-on-push', async e => {
    if (e.pr.draft || !e.worker.taskId) return;
    await dispatchCriterionChecks({ taskId: e.worker.taskId, headSha: e.pr.headSha, headBranch: e.worker.branch });
  }),
  subscriber('reviews', 'pr.synchronized', 'registered-checks-on-push', async e => {
    if (e.pr.draft || !e.worker.taskId) return;
    await registeredChecks(e.worker.taskId, e.pr.headSha, `PR #${e.pr.number} push`);
  }),
  // The runner's report that lands after the agent completed a verification
  // run itself: kept, and turned into the check or command-criterion verdict.
  subscriber('reviews', 'worker.late_verification_reported', 'late-runner-evidence', async e => {
    await recordLateRunnerEvidence({ workerId: e.workerId, taskId: e.taskId, evidence: e.verificationEvidence });
  }),
  subscriber('reviews', 'worker.reported', 'spec-check-outcome', async e => {
    const [row] = await db.select({ context: tasks.context }).from(tasks).where(eq(tasks.id, e.taskId)).limit(1);
    if (!isCriterionCheckTask(row?.context)) return;
    await handleCriterionCheckOutcome(e.taskId, e.verificationEvidence);
  }),
];
