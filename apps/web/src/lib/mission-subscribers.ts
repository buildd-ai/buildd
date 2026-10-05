/**
 * Missions module: what a worker's report, and a task filed against a
 * mission, mean for that mission.
 *
 * `task.created`: a task filed against a mission (dashboard, API, an external
 * MCP caller) is attributed in the mission feed, reopens a completed mission,
 * and resolves a criteria escalation ("file the work" is one of its two
 * advertised exits). Fire-and-forget: the chain is not awaited, so it never
 * delays the request. Its modules are imported lazily, as the inline chain
 * did.
 *
 * `worker.reported` (lib/core-events.ts). Order is load-bearing
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
  subscriber('missions', 'task.created', 'task-created-mission-feed', e => {
    if (!e.missionId) return;
    const missionId = e.missionId;
    import('@/lib/mission-feed').then(async (feedMod) => {
      const feedActor = await feedMod.resolveFeedActor({
        user: e.creator.user, apiAccount: e.creator.apiAccount, actorWorkerId: e.creator.workerId,
      });
      await feedMod.postMissionFeedEvent({
        missionId,
        type: 'update',
        title: `Task created: ${e.title}`,
        body: `Task ${e.taskId}`,
        actor: feedActor,
        taskId: e.taskId,
      });
      // Idempotent; a no-op when the mission is not completed.
      const { reopenCompletedMission } = await import('@/lib/mission-loop');
      await reopenCompletedMission(missionId, feedActor)
        .catch(err => console.error('[task-create] mission reopen failed:', err));
      // Routed through the single writer; a no-op when the mission was never
      // escalated. Its own catch, so a reopen failure never blocks it.
      const { resolveCriteriaEscalation } = await import('@/lib/criteria-escalation');
      await resolveCriteriaEscalation(missionId, 'work_filed', feedActor)
        .catch(err => console.error('[task-create] criteria escalation resolve failed:', err));
    }).catch(err => console.error('[task-create] mission-feed failed:', err));
  }),

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
