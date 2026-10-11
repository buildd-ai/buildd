/**
 * Spec criterion checks on a PR head (lib/specs/criterion-checks.ts).
 *
 * - `pr.review_ready` (opened ready, or out of draft) and `pr.synchronized`
 *   (a push): file one check run per checked criterion of the task's pinned
 *   revision for that head. Every delivery: dispatch is idempotent per head.
 * - `worker.reported` for a check run: its exit code becomes the verdict at
 *   the head it ran on.
 *
 * Advisory (D-5): a verdict feeds the governed outcome and blocks nothing.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { currentPrHeadSha } from '@/lib/specs/outcome';
import { dispatchCriterionChecks, handleCriterionCheckOutcome, isCriterionCheckTask } from '@/lib/specs/criterion-checks';

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
  subscriber('reviews', 'worker.reported', 'spec-check-outcome', async e => {
    const [row] = await db.select({ context: tasks.context }).from(tasks).where(eq(tasks.id, e.taskId)).limit(1);
    if (!isCriterionCheckTask(row?.context)) return;
    await handleCriterionCheckOutcome(e.taskId, e.verificationEvidence);
  }),
];
