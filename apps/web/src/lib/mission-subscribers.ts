/**
 * Missions module: what a worker's report means for its mission.
 *
 * Subscribes to `worker.reported` (lib/core-events.ts). Order is load-bearing
 * and fixed by this list: the three criteria verdict handlers hand a finished
 * criteria task's evidence back BEFORE the completion attempt, so a criterion
 * turning green completes the mission in the same request; the subject sweep
 * runs after. Each step is isolated by the emitter, and pages under its label.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { completeMissionIfVerified } from '@/lib/mission-completion';
import { handleCriteriaVerificationOutcome, isCriteriaVerificationTask } from '@/lib/mission-criteria-verify';
import { handleProseEvalOutcome, isProseEvalTask } from '@/lib/mission-criteria-prose';
import { handleCriteriaWorkerEvalOutcome, isCriteriaWorkerEvalTask } from '@/lib/mission-criteria-worker-eval';
import { sweepSubjectAnchoredTasks } from '@/lib/subject-sweep';

async function taskContext(taskId: string): Promise<unknown> {
  const [row] = await db
    .select({ context: tasks.context })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  return row?.context;
}

export const missionSubscribers: readonly AnySubscriber[] = [
  // A finished goal-criterion verification task owns one criterion's verdict.
  subscriber('missions', 'worker.reported', 'criteria-verification-outcome', async e => {
    if (!isCriteriaVerificationTask(await taskContext(e.taskId))) return;
    await handleCriteriaVerificationOutcome(e.taskId, e.verificationEvidence);
  }),
  // A finished prose grading task owns the verdicts for the criteria it was asked about.
  subscriber('missions', 'worker.reported', 'criteria-prose-outcome', async e => {
    if (!isProseEvalTask(await taskContext(e.taskId))) return;
    await handleProseEvalOutcome(e.taskId, e.structuredOutput);
  }),
  // A finished worker-eval task owns verdicts for the LLM-eligible + command criteria it was asked about.
  subscriber('missions', 'worker.reported', 'criteria-worker-eval-outcome', async e => {
    if (!isCriteriaWorkerEvalTask(await taskContext(e.taskId))) return;
    await handleCriteriaWorkerEvalOutcome(e.taskId, e.structuredOutput);
  }),
  // The predicate pulls a goal-criteria verdict when the work is done, refuses
  // when it cannot get one, and is a cheap no-op while deliverables are still
  // open, so it is safe on every report. `proposed: false`: nothing asserted
  // completion here, so a still-working mission does not post a note.
  subscriber('missions', 'worker.reported', 'mission-completion-attempt', async e => {
    if (e.missionId) {
      await completeMissionIfVerified(e.missionId, { path: 'criteria_eval', predicate: `task ${e.taskId} reached ${e.status}` });
    }
  }),
  // A task anchored to a subject PR: re-sweep every task anchored to that PR
  // now that this attempt has reported.
  subscriber('missions', 'worker.reported', 'subject-anchor-sweep', async e => {
    if (!e.workspaceId) return;
    const [row] = await db
      .select({ subjectPrNumber: tasks.subjectPrNumber })
      .from(tasks)
      .where(eq(tasks.id, e.taskId))
      .limit(1);
    if (row?.subjectPrNumber) {
      await sweepSubjectAnchoredTasks(e.workspaceId, row.subjectPrNumber);
    }
  }),
];
