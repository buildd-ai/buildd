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
 * GitHub facts (the webhook emits them; lib/core-events.ts):
 * - `task.pr_merge_delivered` (every delivery): a loop waiting on the merge
 *   advances; a task PR landing on the integration branch opens the mission PR.
 * - `task.pr_merged` (once per merge, after the status transition): the
 *   mission wakes, and missions gated on this one's merges are unblocked.
 * - `pr.closed` / `pr.base_changed`: surface ordering's change intents settle
 *   or follow the PR to its new base (network work in after()).
 * - `pr.needs_human`: the mission's "PR ready" notification.
 *
 * `worker.reported` (lib/core-events.ts), and the `via: 'release'` outcome of
 * a release that report left held for CI. Order is load-bearing
 * and fixed by this list: the three criteria verdict handlers hand a finished
 * criteria task's evidence back BEFORE the completion attempt, so a criterion
 * turning green completes the mission in the same request; the subject sweep
 * runs after. Each step is isolated by the emitter, and pages under its label.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { after } from 'next/server';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { evaluateAndAdvanceLoopOnMerge } from '@/lib/loop-webhook';
import { maybeOpenMissionIntegrationPr, noteMissionPrOpenFailure } from '@/lib/mission-pr';
import { wakeMissionAfterResponse } from '@/lib/mission-wake';
import { checkAndUnblockDependentMissions } from '@/lib/mission-dependency';
import { notifyMissionPrReady } from '@/lib/mission-notifications';
import { completeMissionIfVerified } from '@/lib/mission-completion';
import { handleCriteriaVerificationOutcome, isCriteriaVerificationTask } from '@/lib/mission-criteria-verify';
import { handleProseEvalOutcome, isProseEvalTask } from '@/lib/mission-criteria-prose';
import { handleCriteriaWorkerEvalOutcome, isCriteriaWorkerEvalTask } from '@/lib/mission-criteria-worker-eval';
import { undraftStackedDependents } from '@/lib/early-release-stacking';
import { scheduleEarlyReleaseDispatch } from '@/lib/early-release-dispatch-trigger';
import { workspaces } from '@buildd/core/db/schema';
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

  // ── GitHub facts ───────────────────────────────────────────────────────────
  // A trunk merge refreshes active mission branches after the response. The
  // hourly sweep covers lost webhook deliveries; the helper coalesces repeats.
  subscriber('missions', 'pr.merged', 'refresh-mission-branches', async e => {
    if (e.delivery?.installationId == null || !e.delivery.baseRef) return;
    const repoFullName = e.repoFullName;
    const baseRef = e.delivery.baseRef;
    const refresh = () => import('@/lib/mission-branch-refresh')
      .then(m => m.refreshMissionBranchesForTrunkMerge({ repoFullName, baseRef }))
      .then(() => {}, err => console.error(`[webhook] mission branch refresh failed for ${repoFullName}@${baseRef}:`, err));
    try {
      after(refresh);
    } catch {
      await refresh();
    }
  }),
  subscriber('missions', 'pr.ready_for_review', 'dispatch-early-release', async e => {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, e.workspaceId),
      columns: { teamId: true, gitConfig: true },
    });
    if (!workspace) return;
    scheduleEarlyReleaseDispatch({
      workspaceId: e.workspaceId, teamId: workspace.teamId, gitConfig: workspace.gitConfig,
      upstreamTaskId: e.taskId, upstreamPrNumber: e.prNumber, upstreamBranch: e.branch,
      repoFullName: e.repoFullName, installationId: e.installationId,
      upstreamAdditions: e.additions, upstreamDeletions: e.deletions,
    });
  }),
  subscriber('missions', 'task.pr_merge_delivered', 'undraft-stacked-dependents', e => {
    undraftStackedDependents(e.taskId).catch(err =>
      console.error(`[webhook] undraftStackedDependents failed for task ${e.taskId}:`, err));
  }),
  // mergedAt is stamped; the helper reads it and completes the task if its
  // pr_merged loop condition now holds. Fire-and-forget.
  subscriber('missions', 'task.pr_merge_delivered', 'loop-advance-on-merge', e => {
    if (!e.taskId || !e.workspaceId) return;
    evaluateAndAdvanceLoopOnMerge(e.workerId, e.taskId, e.workspaceId).catch((err) =>
      console.error(`[webhook] evaluateAndAdvanceLoopOnMerge failed for task ${e.taskId}:`, err),
    );
  }),
  // Option A′: a task PR landing on the mission's integration branch is the
  // event that can make the mission's work complete, so it is where the one
  // mission PR gets opened. Awaited, not fire-and-forget: this opens a PR, and
  // a detached promise in a serverless handler can be killed mid-call, which
  // would leave a mission whose work is done and whose PR never appeared.
  // `assumeCompletedTaskIds` because tasks.status for THIS task is stamped
  // after this; workers.mergedAt already is.
  subscriber('missions', 'task.pr_merge_delivered', 'open-mission-integration-pr', async e => {
    if (!e.missionId || !e.baseRef) return;
    const missionId = e.missionId;
    const opened = await maybeOpenMissionIntegrationPr(missionId, {
      assumeCompletedTaskIds: [e.taskId],
    }).catch(err => {
      console.error(`[webhook] mission PR open failed for mission ${missionId}:`, err);
      return null;
    });
    if (opened && !opened.ok && opened.reason !== 'work_incomplete') {
      // `work_incomplete` is the normal answer on all but the last merge.
      // Anything else means an opted-in mission finished its work and still
      // has no PR, which must not be silent.
      console.error(
        `[webhook] mission ${missionId} work is done but its PR did not open: `
        + `${opened.reason}${opened.detail ? ` (${opened.detail})` : ''}`,
      );
      noteMissionPrOpenFailure(missionId, opened).catch(err =>
        console.error(`[webhook] mission PR failure note failed for ${missionId}:`, err),
      );
    }
  }),
  // An attempt task's completion deliberately does not re-plan
  // (mission-loop.ts); the merge it carried still should. A task that was
  // already completed (its worker finished with the PR open) fires no
  // completion now, but the mission's loop may be paused on exactly this PR
  // (evaluateMissionOpenPrGate). Either way: wake it.
  subscriber('missions', 'task.pr_merged', 'mission-wake-on-merge', e => {
    if (e.via !== 'worker' || !e.missionId) return;
    const wake = (e.transition === 'flipped' && e.taskClass === 'attempt') || e.transition === 'already_completed';
    if (wake) wakeMissionAfterResponse(e.missionId, 'pr_merged');
  }),
  // Unblock missions waiting on this mission's PRs to merge. Safe for an
  // already-completed task: the helper re-checks the mission-wide predicate
  // and its write is guarded on dependencyMetAt IS NULL. Fire-and-forget.
  subscriber('missions', 'task.pr_merged', 'unblock-dependent-missions', e => {
    if (!e.missionId) return;
    const missionId = e.missionId;
    checkAndUnblockDependentMissions(missionId, 'merged').catch(err =>
      console.error(
        e.via === 'worker'
          ? `[webhook] unblock failed for merged PR mission ${missionId}:`
          : `[webhook] unblock failed for branch-match merged PR mission ${missionId}:`,
        err,
      ),
    );
  }),
  subscriber('missions', 'pr.closed', 'settle-surface-intents', async e => {
    const settle = () => import('@/lib/surface-ordering')
      .then((m) => m.settleSurfaceIntentsOnClose({ workspaceId: e.workspaceId, prNumber: e.prNumber }))
      .then(() => {}, (err) => console.error(`[webhook] surface settle failed for PR #${e.prNumber}:`, err));
    try {
      after(settle);
    } catch {
      await settle();
    }
  }),
  // A retarget leaves the PR's change-intent rows naming the OLD base. Move its
  // open intents to where the PR now lands and re-wake the head of both lanes.
  subscriber('missions', 'pr.base_changed', 'retarget-surface-intents', async e => {
    const retarget = () => import('@/lib/surface-ordering')
      .then((m) => m.retargetSurfaceIntents({ workspaceId: e.workspaceId, prNumber: e.prNumber, fromBase: e.fromBase, toBase: e.toBase }))
      .then(() => {}, (err) => console.error(`[webhook] surface intent retarget failed for PR #${e.prNumber}:`, err));
    try {
      after(retarget);
    } catch {
      await retarget();
    }
  }),
  subscriber('missions', 'pr.needs_human', 'notify-mission-pr-ready', async e => {
    await notifyMissionPrReady(e.missionId, {
      title: e.title, prUrl: e.prUrl, prNumber: e.prNumber, headSha: e.headSha, reason: e.reason, message: e.message,
    });
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
  // It hears the task's FINAL status: a completion a slot failed reached
  // `failed`. A release held for CI is not an outcome: its row still reads
  // completed while the release may yet fail, so the attempt waits for the
  // release PR's CI (the two subscribers below).
  subscriber('missions', 'worker.reported', 'mission-completion-attempt', async e => {
    if (!e.missionId || e.releaseHeld) return;
    await completeMissionIfVerified(e.missionId, { path: 'criteria_eval', predicate: `task ${e.taskId} reached ${e.finalStatus ?? e.status}` });
  }),
  subscriber('missions', 'task.completed', 'mission-completion-on-release-completed', async e => {
    if (e.via !== 'release' || !e.missionId) return;
    await completeMissionIfVerified(e.missionId, { path: 'criteria_eval', predicate: `task ${e.taskId} reached completed` });
  }),
  subscriber('missions', 'task.failed', 'mission-completion-on-release-failed', async e => {
    if (e.via !== 'release' || !e.missionId) return;
    await completeMissionIfVerified(e.missionId, { path: 'criteria_eval', predicate: `task ${e.taskId} reached failed` });
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
