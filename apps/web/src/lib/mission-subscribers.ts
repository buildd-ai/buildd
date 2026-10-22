/**
 * Missions module: what a worker's report, and a task filed against a
 * mission, mean for that mission.
 *
 * `tasks.claimed`: the integration branch is refreshed before the work
 * starts, and a mission's first build claim snapshots its workspace's
 * standards (lib/specs/mission-standards.ts).
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
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { registerMissionVerdictRecorder } from '@/lib/specs/criterion-checks';
import { recordMissionVerdictServer } from '@/lib/specs/mission-outcome';

// A final-verification check's verdict lands on the mission; core reaches it through this hook.
registerMissionVerdictRecorder((missionId, input) => recordMissionVerdictServer(missionId, input as Parameters<typeof recordMissionVerdictServer>[1]));
import { after } from 'next/server';
import { refreshMissionBranchesBeforeStart } from '@/lib/mission-branch-refresh';
import { scheduleStandardsSnapshots } from '@/lib/specs/mission-standards';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { evaluateAndAdvanceLoopOnMerge, evaluateAndAdvanceLoopOnCiGreen } from '@/lib/loop-webhook';
import { maybeOpenMissionIntegrationPr, noteMissionPrOpenFailure } from '@/lib/mission-pr';
import { wakeMissionAfterResponse } from '@/lib/mission-wake';
import { checkAndUnblockDependentMissions } from '@/lib/mission-dependency';
import { notifyMissionPrReady } from '@/lib/mission-notifications';
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
  // A mission task is starting: bring its integration branch up to date with
  // trunk first, so the work cuts from current trunk
  // (docs/specs/mission-branch-refresh.md). Awaited by the claim, bounded by
  // START_REFRESH_BUDGET_MS, and never throws. A trunk merge alone no longer
  // refreshes anything. A refresh past its budget is kept alive with after();
  // if the request dies anyway, its expired lease makes the backstop retry it.
  subscriber('missions', 'tasks.claimed', 'refresh-mission-branches-before-start', async e => {
    await refreshMissionBranchesBeforeStart(e.tasks, {
      keepAlive: pending => after(() => pending.then(() => {})),
    });
  }),
  // Living Specs D-43: a mission's first build claim snapshots the workspace's
  // standards onto it. After the response, and never fails the claim.
  subscriber('missions', 'tasks.claimed', 'snapshot-standards-at-build-start', e => {
    scheduleStandardsSnapshots(e.tasks.map(t => ({ taskId: t.id, missionId: t.missionId })));
  }),
  // §6: deliverable work filed into a mission gets its scope decision (in
  // scope, a recorded amendment, or a hold for a person), and, when the
  // mission's newest delivery already merged, a writable successor delivery,
  // so the claim hands its worker a live branch.
  // After the response, like the merge and retarget subscribers below: the scope decision is a
  // model call that can run to its timeout, and filing a task must never wait on it. A late
  // branch is safe: the claim swaps a stale filed base for the live one.
  subscriber('missions', 'task.created', 'open-writable-mission-delivery', e => {
    if (!e.missionId) return;
    const missionId = e.missionId;
    after(() => (async () => {
      const [task] = await db
        .select({ taskClass: tasks.taskClass, mode: tasks.mode })
        .from(tasks)
        .where(eq(tasks.id, e.taskId))
        .limit(1);
      if (task?.taskClass !== 'work' || task.mode === 'planning') return;
      const { decideMissionTaskScope, ensureMissionWritableBranch } = await import('@/lib/mission-epoch-door');
      // The scope decision first: an amended contract is the version the next delivery carries.
      await decideMissionTaskScope({ taskId: e.taskId, workspaceId: e.workspaceId });
      await ensureMissionWritableBranch(missionId, 'task_filed');
    })().catch(err => console.error('[task-create] mission scope/delivery failed:', err)));
  }),
  // §6: an existing task linked to the mission gets the same scope decision as one filed into it
  // (and the same compare-and-set on the scope version), then the same writable delivery.
  subscriber('missions', 'task.joined_mission', 'decide-linked-task-scope', e => {
    after(() => (async () => {
      const { decideMissionTaskScope, ensureMissionWritableBranch } = await import('@/lib/mission-epoch-door');
      const decided = await decideMissionTaskScope({ taskId: e.taskId, workspaceId: e.workspaceId, origin: 'linked' });
      if (decided) await ensureMissionWritableBranch(e.missionId, 'task_linked');
    })().catch(err => console.error('[task-link] mission scope/delivery failed:', err)));
  }),
  // A task that left the mission before anyone answered its held scope decision: the decision is
  // withdrawn and the hold it placed released. A no-op for a task with no held decision there.
  subscriber('missions', 'task.left_mission', 'withdraw-scope-decision', e => {
    if (!e.workspaceId) return;
    const workspaceId = e.workspaceId;
    after(() => import('@/lib/mission-epoch-door').then(({ answerMissionTaskScopeQuietly }) => answerMissionTaskScopeQuietly({
      taskId: e.taskId, workspaceId, missionId: e.missionId, answer: 'withdrawn', actor: 'system:task_left_mission',
    })).catch(err => console.error('[task-unlink] scope withdrawal failed:', err)));
  }),
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
  // mergedAt is stamped; the helpers read it and complete the task if its
  // pr_merged loop condition now holds, or its pr_checks_green one (a merge
  // satisfies that too, should no green delivery have reached us first).
  // Fire-and-forget.
  subscriber('missions', 'task.pr_merge_delivered', 'loop-advance-on-merge', e => {
    if (!e.taskId || !e.workspaceId) return;
    evaluateAndAdvanceLoopOnMerge(e.workerId, e.taskId, e.workspaceId).catch((err) =>
      console.error(`[webhook] evaluateAndAdvanceLoopOnMerge failed for task ${e.taskId}:`, err),
    );
    evaluateAndAdvanceLoopOnCiGreen(e.workerId, e.taskId, e.workspaceId, 'merged').catch((err) =>
      console.error(`[webhook] evaluateAndAdvanceLoopOnCiGreen(merged) failed for task ${e.taskId}:`, err),
    );
  }),
  // The pr_checks_green counterpart: a task the loop parked on its PR's CI
  // (lib/loop-dispatcher-policy.ts) completes when the checks go green.
  subscriber('missions', 'pr.ci_passed', 'loop-advance-on-ci-green', e => {
    if (!e.taskId) return;
    evaluateAndAdvanceLoopOnCiGreen(e.workerId, e.taskId, e.workspaceId, 'ci_green').catch((err) =>
      console.error(`[webhook] evaluateAndAdvanceLoopOnCiGreen failed for task ${e.taskId}:`, err),
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
  // §6 (workflow-kernel-library.md): a mission PR merged on GitHub itself
  // (no buildd door ran) is still a merged delivery. Every door records it
  // too; the kernel's transition is idempotent, so the second is a noop.
  subscriber('missions', 'pr.closed', 'record-mission-delivery-merged', async e => {
    if (!e.merged || !e.taskId || e.installationId == null) return;
    const [task] = await db
      .select({ title: tasks.title, taskClass: tasks.taskClass, missionId: tasks.missionId })
      .from(tasks)
      .where(eq(tasks.id, e.taskId))
      .limit(1);
    const { isMissionPrTask } = await import('@buildd/core/mission-integration');
    if (!task?.missionId || !isMissionPrTask(task)) return;
    const { recordMissionPrMerged } = await import('@/lib/mission-epoch-door');
    await recordMissionPrMerged(task, e.installationId, e.repoFullName, e.prNumber);
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
  // §6: GitHub moved a mission PR off a delivery branch (delete-on-merge
  // retargets it to trunk). Recorded on the delivery, so settlement moves only
  // PRs that were really on it.
  subscriber('missions', 'pr.base_changed', 'record-pr-moved-off-delivery', async e => {
    const [row] = await db
      .select({ missionId: tasks.missionId })
      .from(workers)
      .innerJoin(tasks, eq(tasks.id, workers.taskId))
      .where(and(eq(workers.workspaceId, e.workspaceId), eq(workers.prNumber, e.prNumber)))
      .limit(1);
    if (!row?.missionId) return;
    const { recordPrMovedOffDelivery } = await import('@/lib/mission-epoch-door');
    await recordPrMovedOffDelivery({ missionId: row.missionId, prNumber: e.prNumber, fromBase: e.fromBase });
  }),
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
  // S4b (workflow-kernel-library.md §1, §6): a settled or retired delivery can be the last thing
  // a mission's completion was held on (`epochCompletionHold`).
  subscriber('missions', 'mission.delivery_settled', 'mission-completion-on-delivery-settled', async e => {
    await completeMissionIfVerified(e.missionId, { path: 'epoch_settled', predicate: `delivery ${e.steps.join(', ')}` });
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
