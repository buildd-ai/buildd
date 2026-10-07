/**
 * A red CI result on one PR → a bounded CI-fix task, or a recorded reason why not.
 *
 * Part of the Ralph loop: CI fails → fix task → agent fixes on the same branch →
 * CI re-runs → (with autoMergePR) merges. Two doors call it:
 *   - the `check_suite` webhook (`handleCheckSuiteFailure`), once per PR in the
 *     failed suite;
 *   - the red-PR sweep (lib/ci-red-sweep.ts), for a PR still red with nobody
 *     fixing it — the event that would have retried it was lost, or arrived
 *     while a fix was in flight that then finished without pushing.
 *
 * Guard rails:
 * - Only acts on PRs created by a buildd worker (or adopted, see below).
 * - Skips draft, merged and closed PRs, and owners that failed or were cancelled.
 *   A completed owner still gets the retry: its PR is open and red.
 * - Never stacks on a fix attempt for the same PR that is still pending/running.
 * - One attempt per PR + head: a head an attempt already ran on is not retried
 *   again (structurally too, by the workspace + PR + head unique index).
 * - Honors gitConfig.maxCiRetries (default 3; 0 disables), counted from the CI
 *   retries already filed for the PR. On exhaustion, marks the owner task
 *   failed and notifies the mission instead of looping.
 *
 * Every "no retry" return writes a `ci_retry_skipped` gate row with a stable
 * `detail.skipReason` — before this, each was a console line and a red PR
 * nobody was fixing had no record of why.
 */

import { checkDispatch } from '@/lib/supersession';
import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { notifyMissionPrReady } from '@/lib/mission-notifications';
import { buildCIRetryTask, summarizePrFixAttempts } from '@/lib/ci-retry';
import { captureCiJobLogEvidence } from '@/lib/ci-job-log-evidence';
import {
  fetchPrRetryGate,
  fetchCIFailureLogs,
  fetchCommitAuthor,
  isBuilddWorkerCommit,
} from '@/lib/ci-failure-inspect';
import { isSchemaDriftFailure, buildDriftDiagnoseTask } from '@/lib/ci-drift-diagnose';
import { inheritAttemptIdentity } from '@/lib/attempt-identity';
import { prepareSubjectFiling, recordSubjectMatchObserved } from '@/lib/subject-anchor-observer';
import { workerOwnsPr, workspaceRepoMatches } from '@/lib/repo-scope';
import { appendPrActivity, taskActivityUrl } from '@/lib/pr-activity-comment';
import { resolveOrAdoptPrOwner } from '@/lib/pr-review-request';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import { dependencyBotPushRefusal, isDependencyBotAuthor, isDependencyBotPrContext } from '@/lib/dependency-bot-pr';
import { isTerminalPrLifecycle } from '@/lib/dep-gate-contract';
import { CI_RED_ESCALATED_KEY, scheduleCiRedLook } from '@/lib/ci-red-queue';

/** Which door asked. Recorded as the gate row's `surface`. */
export type CiRetrySurface = 'webhook:check_suite' | 'cron:ci-red';

/** How long after a skipped retry the sweep looks again. One gated tick past a normal CI run. */
export const CI_RED_LOOK_AGAIN_MS = 30 * 60_000;


export type CiRetrySkipReason =
  | 'owner_stopped'
  | 'pr_terminal'
  | 'no_workspace'
  | 'draft'
  | 'pr_merged'
  | 'pr_closed'
  | 'fix_in_flight'
  | 'head_already_retried'
  | 'retries_exhausted'
  | 'retries_disabled'
  | 'duplicate';

/** Fixed text per code: the ledger coalesces on (gate, outcome, reason), so the PR number lives in `detail`. */
const SKIP_REASON_TEXT: Record<CiRetrySkipReason, string> = {
  owner_stopped: 'no CI retry: the PR owner task failed or was cancelled',
  pr_terminal: 'no CI retry: the PR is already merged, closed or unresolvable',
  no_workspace: 'no CI retry: the owner task has no workspace',
  draft: 'no CI retry: the PR is a draft',
  pr_merged: 'no CI retry: the PR is merged on GitHub',
  pr_closed: 'no CI retry: the PR is closed on GitHub',
  fix_in_flight: 'no CI retry yet: a fix attempt for this PR is still in flight',
  head_already_retried: 'no CI retry: an attempt already ran on this head',
  retries_exhausted: 'no CI retry: the PR used its whole CI retry budget',
  retries_disabled: 'no CI retry: CI retries are disabled for this workspace',
  duplicate: 'no CI retry: a retry for this PR and head was filed concurrently',
};

export type CiRetryOutcome =
  | { kind: 'dispatched'; taskId: string }
  | { kind: 'diagnose_dispatched'; taskId: string }
  | { kind: 'skipped'; reason: CiRetrySkipReason; inFlightTaskId?: string; priorAttemptTaskId?: string }
  /** Not a buildd PR (no owner, fork, unreadable, dependency bot): nothing of ours to record or fix. */
  | { kind: 'not_ours' };

export interface CiFailureInput {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  installationId: number;
  surface: CiRetrySurface;
}

interface SkipContext {
  input: CiFailureInput;
  workspaceId: string;
  taskId: string;
  workerId: string;
}

function recordSkip(
  ctx: SkipContext,
  reason: CiRetrySkipReason,
  extra: Record<string, unknown> = {},
): void {
  fireGateEvent({
    gate: GATE_SLUGS.CI_RETRY_SKIPPED,
    surface: ctx.input.surface,
    outcome: reason === 'fix_in_flight' ? 'deferred' : 'rejected',
    reason: SKIP_REASON_TEXT[reason],
    workspaceId: ctx.workspaceId,
    taskId: ctx.taskId,
    workerId: ctx.workerId,
    callerOrigin: 'system',
    detail: {
      skipReason: reason,
      prNumber: ctx.input.prNumber,
      headSha: ctx.input.headSha,
      repo: ctx.input.repoFullName,
      ...extra,
    },
  });
}

/**
 * The webhook is the only door that needs to ask the sweep to come back: the
 * sweep reschedules its own looks.
 */
async function lookAgain(ctx: SkipContext): Promise<void> {
  if (ctx.input.surface !== 'webhook:check_suite') return;
  await scheduleCiRedLook({ workspaceId: ctx.workspaceId, prNumber: ctx.input.prNumber }, Date.now() + CI_RED_LOOK_AGAIN_MS);
}

/**
 * True for the bookkeeping task `resolveOrAdoptPrOwner` creates for a PR
 * buildd did not open. Its `status` is always 'completed' (the PR already
 * exists — a pending row here would be claimable and "redone"), which would
 * otherwise look identical to a task whose real agent work genuinely
 * finished. Callers that gate on terminal status must exempt this case.
 */
export function isAdoptedPrTask(task: { context: unknown }): boolean {
  const context = task.context as Record<string, unknown> | null;
  return !!context?.adoptedPr;
}

export interface EscalationInput {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  task: { id: string; title: string; workspaceId: string; missionId: string | null; result: unknown };
  /** One line for the owner task's result and the PR comment. */
  detail: string;
  missionTitle: string;
  missionMessage: string;
  failureContext?: string;
  runUrl?: string | null;
}

/**
 * Hand a red PR to a human: fail the owner task (Home's blocked card), tell the
 * mission, and say so on the PR. At most once per PR + head — the owner's
 * context carries the escalated head, and the update only lands when it is a
 * different one, so two doors (or two sweeps) racing on one head escalate once.
 * Returns false when this head was already escalated.
 */
export async function escalateCiRedHead(input: EscalationInput): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: 'failed',
      // Merge, never replace: result.nextSuggestion is the agent's handoff
      // advice and Home's blocked card leads with it. Overwriting the
      // whole object here would delete the only guidance the human gets.
      result: {
        ...((input.task.result as Record<string, unknown> | null) ?? {}),
        summary: `CI retry stopped — ${input.detail}${input.failureContext ? `\n\n${input.failureContext}` : ''}`,
      },
      context: sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), ${`{${CI_RED_ESCALATED_KEY}}`}::text[], to_jsonb(${input.headSha}::text))`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(tasks.id, input.task.id),
      sql`coalesce(${tasks.context}->>${CI_RED_ESCALATED_KEY}, '') <> ${input.headSha}`,
    ))
    .returning({ id: tasks.id });
  if (rows.length === 0) return false;

  if (input.task.missionId) {
    await notifyMissionPrReady(input.task.missionId, {
      title: input.missionTitle,
      prUrl: `https://github.com/${input.repoFullName}/pull/${input.prNumber}`,
      prNumber: input.prNumber,
      headSha: input.headSha,
      reason: 'ci_failed',
      message: input.missionMessage,
    });
  }
  await appendPrActivity({
    installationId: input.installationId,
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
    entry: { kind: 'ci_exhausted', note: input.detail, url: input.runUrl ?? undefined },
    workspaceId: input.task.workspaceId,
  });
  return true;
}

export async function retryCiFailureForPr(input: CiFailureInput): Promise<CiRetryOutcome> {
  const { repoFullName, prNumber, headSha, installationId, surface } = input;

  // A PR under an active retry loop can have more than one worker row
  // stamped with the same prNumber — the original worker and each retry
  // attempt's own worker, since a retry continues on the SAME branch/PR. Order
  // by newest so the iteration read below comes from the latest attempt's
  // context, not an earlier (possibly iteration-less) one — see the openWorker
  // fix in PR #2574, which this mirrors for the CI-retry path.
  let worker = await db.query.workers.findFirst({
    where: workerOwnsPr(repoFullName, prNumber),
    with: { task: true },
    orderBy: [desc(workers.createdAt)],
  });

  if (!worker?.task) {
    // No worker owns this PR — a release PR opened by `workflow_dispatch`,
    // a hand-pushed PR, or an external contribution. Adopt it through the
    // SAME path `request_pr_review` uses (see resolveOrAdoptPrOwner), then
    // fall through to the normal retry logic below. Adoption is scoped to
    // repos this workspace actually manages, and skipped for forks — a
    // fork's CI failure is not buildd's to fix.
    const adoptingWorkspace = await db.query.workspaces.findFirst({
      where: workspaceRepoMatches(repoFullName),
    });
    if (!adoptingWorkspace) return { kind: 'not_ours' };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let prData: any = null;
    try {
      prData = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
    } catch (err) {
      console.warn(`[ci-retry] Could not fetch PR #${prNumber} on ${repoFullName} for adoption:`, err);
    }
    if (!prData?.number) return { kind: 'not_ours' };

    const headRepoFullName = prData.head?.repo?.full_name as string | undefined;
    const isFork = !!headRepoFullName && headRepoFullName.toLowerCase() !== repoFullName.toLowerCase();
    if (isFork) {
      console.log(`[ci-retry] Skipping adoption of fork PR #${prNumber} on ${repoFullName}`);
      return { kind: 'not_ours' };
    }

    // Renovate/Dependabot own their branch and stop rebasing it the moment
    // anyone else commits — a CI fix from buildd would hijack the PR.
    if (isDependencyBotAuthor(prData.user)) {
      console.log(
        `[ci-retry] Skipping adoption of dependency-bot PR #${prNumber} on ${repoFullName} (author: ${prData.user?.login})`,
      );
      fireGateEvent({
        gate: GATE_SLUGS.DEPENDENCY_BOT_PR,
        surface,
        outcome: 'rejected',
        reason: 'CI failed on a dependency-bot PR — not adopted, the bot owns the branch',
        workspaceId: adoptingWorkspace.id,
        callerOrigin: 'system',
        detail: { prNumber, repo: repoFullName, author: prData.user?.login ?? null, stage: 'adoption' },
      });
      return { kind: 'not_ours' };
    }

    const { ownerWorker } = await resolveOrAdoptPrOwner({
      workspaceId: adoptingWorkspace.id,
      installationId,
      repoFullName,
      prNumber,
      pr: prData,
      creationSource: 'webhook',
    });

    worker = await db.query.workers.findFirst({
      where: eq(workers.id, ownerWorker.id),
      with: { task: true },
    });
    if (!worker?.task) return { kind: 'not_ours' };
  }
  const task = worker.task;
  const skipCtx: SkipContext = { input, workspaceId: task.workspaceId, taskId: task.id, workerId: worker.id };

  // Already adopted (an explicit request_pr_review) — reviewing a bot PR is
  // fine, pushing a CI fix to its branch is not.
  if (isDependencyBotPrContext(task.context)) {
    console.log(`[ci-retry] No CI-fix for dependency-bot PR #${prNumber} on ${repoFullName}`);
    fireGateEvent({
      gate: GATE_SLUGS.DEPENDENCY_BOT_PR,
      surface,
      outcome: 'rejected',
      reason: dependencyBotPushRefusal(prNumber),
      workspaceId: task.workspaceId,
      taskId: task.id,
      workerId: worker.id,
      callerOrigin: 'system',
      detail: { prNumber, repo: repoFullName, stage: 'ci_fix' },
    });
    return { kind: 'not_ours' };
  }

  // A failed or cancelled owner must not spawn retry children: failed is what
  // the exhaustion path below sets, and cancelled is a human stopping the
  // work. Surface the failure to the mission feed instead (AC-5) — from the
  // webhook only: the sweep finding the same owner again is not news.
  //
  // 'completed' is NOT a stop. Workers call complete_task right after they
  // push, so a PR's root task and every review/conflict/CI fix attempt on it
  // are 'completed' by the time CI reports. A completed task whose PR is
  // open and red has not finished its job. What actually ends the loop is
  // checked below: a merged/closed PR, an in-flight fix, the budget.
  const ownerStopped = task.status === 'failed' || task.status === 'cancelled';
  if (ownerStopped && !isAdoptedPrTask(task)) {
    if (task.missionId && surface === 'webhook:check_suite') {
      await notifyMissionPrReady(task.missionId, {
        title: `CI failing on ${task.status} task PR`,
        prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
        prNumber,
        headSha,
        reason: 'ci_failed',
        message: `${task.title} — CI failed on the ${task.status} task's PR. Needs a human.`,
      });
    }
    recordSkip(skipCtx, 'owner_stopped', { ownerStatus: task.status });
    return { kind: 'skipped', reason: 'owner_stopped' };
  }

  // A late failure on a PR that already landed or was closed is not ours to fix.
  if (isTerminalPrLifecycle(worker.prLifecycleStatus)) {
    console.log(`Skipping CI retry for PR #${prNumber} on ${repoFullName}: PR is ${worker.prLifecycleStatus}`);
    recordSkip(skipCtx, 'pr_terminal', { lifecycle: worker.prLifecycleStatus });
    return { kind: 'skipped', reason: 'pr_terminal' };
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, task.workspaceId),
  });
  if (!workspace) {
    console.log(`No workspace found for task ${task.id}, skipping CI retry`);
    recordSkip(skipCtx, 'no_workspace');
    return { kind: 'skipped', reason: 'no_workspace' };
  }

  // Guard: skip draft PRs (not ready for CI feedback) and merged/closed ones
  // (the lifecycle column above can lag the webhook that closed the PR).
  const prGate = await fetchPrRetryGate(installationId, repoFullName, prNumber);
  if (prGate.draft) {
    console.log(`Skipping CI retry for draft PR #${prNumber} on ${repoFullName}`);
    recordSkip(skipCtx, 'draft');
    return { kind: 'skipped', reason: 'draft' };
  }
  if (prGate.closed) {
    console.log(`Skipping CI retry for ${prGate.merged ? 'merged' : 'closed'} PR #${prNumber} on ${repoFullName}`);
    const reason = prGate.merged ? 'pr_merged' : 'pr_closed';
    recordSkip(skipCtx, reason);
    return { kind: 'skipped', reason };
  }

  // Dispatch guard: the supersession table in skip_dispatch mode, so a CI fix
  // is never filed for work the reconciler would cancel on sight. An adopted
  // PR's placeholder owner is exempt from the owner-status rules, as above.
  const supersession = await checkDispatch({
    kind: 'ci_retry',
    workspaceId: task.workspaceId,
    prNumber,
    parentTaskId: isAdoptedPrTask(task) ? null : task.id,
    door: surface,
  });
  // `open_retry_supersedes_duplicate` reads the same open-attempt set as the
  // in-flight check below, which also schedules the sweep's look-back — let
  // that branch report it rather than mislabel it here.
  if (supersession.verdict === 'skip_dispatch' && supersession.rule !== 'open_retry_supersedes_duplicate') {
    const reason: CiRetrySkipReason = supersession.rule === 'cancel_supersedes_retry'
      ? 'owner_stopped'
      : supersession.rule?.startsWith('close_') ? 'pr_closed' : 'pr_merged';
    recordSkip(skipCtx, reason, { supersessionRule: supersession.rule });
    return { kind: 'skipped', reason };
  }

  // Every fix attempt filed for this PR: one in flight means another push
  // is coming, so a retry now would stack on it; the rest are the budget.
  const fixAttempts = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      creationSource: tasks.creationSource,
      outputRequirement: tasks.outputRequirement,
      ciRetryPrNumber: tasks.ciRetryPrNumber,
      ciRetryHeadSha: tasks.ciRetryHeadSha,
      conflictRetryPrNumber: tasks.conflictRetryPrNumber,
      context: tasks.context,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(and(
      eq(tasks.workspaceId, task.workspaceId),
      or(
        eq(tasks.ciRetryPrNumber, prNumber),
        eq(tasks.reviewerRetryPrNumber, prNumber),
        eq(tasks.conflictRetryPrNumber, prNumber),
      ),
    ));
  const { inFlight: inFlightOnPr, ciRetriesUsed } = summarizePrFixAttempts(fixAttempts, prNumber);
  // The supersession guard also sees open attempts elsewhere in the retry
  // family (a sibling fixing a sibling's PR), which this PR-scoped query does
  // not: that sibling is in flight for this subject too.
  const familyBlocker = !inFlightOnPr && supersession.rule === 'open_retry_supersedes_duplicate'
    ? supersession.blockers?.[0] ?? null
    : null;
  const inFlight: { id: string; status: string } | null =
    inFlightOnPr ?? (familyBlocker ? { id: familyBlocker, status: 'open' } : null);
  if (inFlight) {
    console.log(
      `Skipping CI retry for PR #${prNumber} on ${repoFullName}: fix attempt ${inFlight.id} is still ${inFlight.status}`,
    );
    // If that attempt finishes without pushing, GitHub never reports this head
    // again — the sweep is the only thing that will come back for it.
    recordSkip(skipCtx, 'fix_in_flight', { inFlightTaskId: inFlight.id, inFlightStatus: inFlight.status });
    await lookAgain(skipCtx);
    return { kind: 'skipped', reason: 'fix_in_flight', inFlightTaskId: inFlight.id };
  }

  // An attempt already ran on this exact head and none is in flight: it ended
  // without pushing. Filing another would hit the PR + head unique index
  // anyway; stopping here saves the log fetch and leaves the sweep to escalate.
  const priorOnHead = fixAttempts.find(a => a.ciRetryPrNumber === prNumber && a.ciRetryHeadSha === headSha);
  if (priorOnHead) {
    recordSkip(skipCtx, 'head_already_retried', { priorAttemptTaskId: priorOnHead.id, priorAttemptStatus: priorOnHead.status });
    await lookAgain(skipCtx);
    return { kind: 'skipped', reason: 'head_already_retried', priorAttemptTaskId: priorOnHead.id };
  }

  // Fetch CI failure logs and commit authorship in parallel to minimise latency.
  const [ciLogs, commitAuthor] = await Promise.all([
    fetchCIFailureLogs(installationId, repoFullName, headSha),
    fetchCommitAuthor(installationId, repoFullName, headSha),
  ]);
  const failureContext = ciLogs.summary ||
    `CI check suite failed on ${repoFullName} PR #${prNumber} (SHA: ${headSha})`;

  // Schema drift is diagnose-only — never a fix agent, automatic or manual.
  // Classified by check name (the only reliable signal here); see
  // ci-drift-diagnose.ts for why. This skips buildCIRetryTask entirely,
  // for both a pre-existing worker's PR and one just adopted above.
  if (isSchemaDriftFailure(ciLogs.failedJobNames)) {
    const diagnoseTask = buildDriftDiagnoseTask({
      originalTask: {
        id: task.id,
        title: task.title,
        workspaceId: task.workspaceId,
        missionId: task.missionId ?? null,
      },
      repoFullName,
      prNumber,
      headSha,
      failureContext,
      ciRunUrl: ciLogs.runUrl,
    });

    // The diagnose task re-attempts the PR's owner task, so it carries the
    // same identity as the CI retry below would (Rule P1-7).
    const diagnoseIdentity = await inheritAttemptIdentity(diagnoseTask.parentTaskId);

    const [newDiagnoseTask] = await db
      .insert(tasks)
      .values({
        workspaceId: diagnoseTask.workspaceId,
        title: diagnoseTask.title,
        description: diagnoseTask.description,
        parentTaskId: diagnoseTask.parentTaskId,
        ...diagnoseIdentity,
        ciRetryPrNumber: prNumber,
        ciRetryHeadSha: headSha,
        missionId: diagnoseTask.missionId,
        context: diagnoseTask.context,
        creationSource: diagnoseTask.creationSource,
        taskClass: diagnoseTask.taskClass,
        outputRequirement: diagnoseTask.outputRequirement,
        status: 'pending',
        priority: 7,
      })
      .onConflictDoNothing()
      .returning();

    if (!newDiagnoseTask) {
      console.log(`Skipping duplicate drift-diagnose task for ${diagnoseTask.workspaceId}/PR #${prNumber}/${headSha}`);
      recordSkip(skipCtx, 'duplicate', { diagnoseOnly: true });
      return { kind: 'skipped', reason: 'duplicate' };
    }
    await announceTaskCreated(newDiagnoseTask, workspace);
    await wakeTask(newDiagnoseTask.id, 'ci.retry');
    console.log(`Created drift-diagnose task ${newDiagnoseTask.id} for PR #${prNumber} on ${repoFullName} (iteration skipped — diagnose only)`);
    await appendPrActivity({
      installationId,
      repoFullName,
      prNumber,
      entry: {
        kind: 'ci_fixing',
        detail: 'schema drift · diagnose only',
        url: ciLogs.runUrl,
        taskUrl: taskActivityUrl(newDiagnoseTask.id),
      },
      workspaceId: diagnoseTask.workspaceId,
    });
    return { kind: 'diagnose_dispatched', taskId: newDiagnoseTask.id };
  }

  // Non-worker commits (human pushes, GitHub Actions, etc.) still need a fix
  // task — the PR is red — but must NOT consume a retry attempt against
  // maxCiRetries. Only buildd-agent-authored SHAs burn the budget.
  const isWorkerCommit = isBuilddWorkerCommit(commitAuthor);
  const foreignHeadSha = !isWorkerCommit;
  const foreignCommitAuthor = foreignHeadSha
    ? (commitAuthor.login ?? commitAuthor.name ?? commitAuthor.email ?? 'unknown')
    : undefined;

  if (foreignHeadSha) {
    console.log(
      `[ci-retry] PR #${prNumber} on ${repoFullName}: head SHA ${headSha} ` +
      `was NOT committed by the buildd worker (author: ${foreignCommitAuthor}). ` +
      `Creating retry task without consuming an attempt.`
    );
  }

  // The owner's own counter is only trustworthy while it is the live
  // attempt; the filed retries are the floor either way.
  const ownerCtx = (task.context as Record<string, unknown>) || {};
  const currentIteration = Math.max(
    typeof ownerCtx.iteration === 'number' ? ownerCtx.iteration : 0,
    ciRetriesUsed,
  );
  const taskCtx = { ...ownerCtx, iteration: currentIteration };

  const retryTask = buildCIRetryTask({
    originalTask: {
      id: task.id,
      title: task.title,
      description: task.description,
      workspaceId: task.workspaceId,
      context: taskCtx,
      missionId: task.missionId ?? null,
    },
    worker: { id: worker.id, branch: worker.branch, prNumber: worker.prNumber },
    failureContext,
    repoFullName,
    ciRunId: ciLogs.runId,
    ciFailedJobId: ciLogs.failedJobId,
    ciRunUrl: ciLogs.runUrl,
    workspaceMaxCiRetries: workspace.gitConfig?.maxCiRetries,
    foreignHeadSha,
    foreignCommitAuthor,
    prRefs: prGate.headRef ? { headRef: prGate.headRef, baseRef: prGate.baseRef ?? null } : null,
  });

  if (!retryTask) {
    // Retries exhausted or disabled — fail the task and escalate to a human.
    // Two distinct causes need different human responses:
    //   • foreignHeadSha: retries disabled (0); a non-worker commit triggered CI failure.
    //   • !foreignHeadSha: the buildd agent genuinely exhausted its N attempts.
    const exhaustionDetail = foreignHeadSha
      ? `CI retries are disabled for this workspace. A non-worker commit by ${foreignCommitAuthor ?? 'an external contributor'} triggered a CI failure on PR #${prNumber}.`
      : `The buildd agent failed ${currentIteration} time(s) and has exhausted its retry budget on PR #${prNumber}.`;
    const missionTitle = foreignHeadSha
      ? 'CI failing — retries disabled (non-worker push)'
      : 'CI failing — agent retries exhausted';
    const missionMessage = foreignHeadSha
      ? `${task.title} — CI failed after a non-worker push by ${foreignCommitAuthor ?? 'external'}. Retries are disabled. Needs a human.`
      : `${task.title} — CI still failing after ${currentIteration} agent attempt(s). Needs a human.`;

    console.log(`CI retries exhausted/disabled for task ${task.id} on ${repoFullName}#${prNumber}. ${exhaustionDetail}`);
    const reason: CiRetrySkipReason = foreignHeadSha || workspace.gitConfig?.maxCiRetries === 0
      ? 'retries_disabled'
      : 'retries_exhausted';
    recordSkip(skipCtx, reason, { attemptsUsed: currentIteration, foreignHeadSha });
    await escalateCiRedHead({
      installationId,
      repoFullName,
      prNumber,
      headSha,
      task: { id: task.id, title: task.title, workspaceId: task.workspaceId, missionId: task.missionId ?? null, result: task.result },
      detail: exhaustionDetail,
      missionTitle,
      missionMessage,
      failureContext,
      runUrl: ciLogs.runUrl,
    });
    return { kind: 'skipped', reason };
  }

  const subjectObservation = await prepareSubjectFiling({
    workspaceId: retryTask.workspaceId,
    workspaceRepo: repoFullName,
    gitConfig: workspace.gitConfig,
    title: retryTask.title,
    description: retryTask.description,
    context: {
      ...retryTask.context,
      ciRetryPrNumber: prNumber,
      ciRetryHeadSha: headSha,
    },
    systemContext: {
      origin: 'retry',
      prNumber,
      headSha,
      branch: worker.branch,
    },
    origin: 'webhook',
  });

  // An attempt inherits the backend, role, routing kind and phase (Rule P1-7)
  // of the task it re-attempts.
  const retryIdentity = await inheritAttemptIdentity(retryTask.parentTaskId);

  const [newTask] = await db
    .insert(tasks)
    .values({
      workspaceId: retryTask.workspaceId,
      title: retryTask.title,
      description: retryTask.description,
      parentTaskId: retryTask.parentTaskId,
      ...retryIdentity,
      ciRetryPrNumber: prNumber,
      ciRetryHeadSha: headSha,
      missionId: retryTask.missionId,
      context: retryTask.context,
      creationSource: retryTask.creationSource,
      taskClass: retryTask.taskClass,
      status: 'pending',
      priority: 7, // CI fix is urgent
      ...subjectObservation.taskValues,
    })
    .onConflictDoNothing()
    .returning();

  if (!newTask) {
    console.log(`Skipping duplicate CI retry for ${task.workspaceId}/PR #${prNumber}/${headSha}`);
    recordSkip(skipCtx, 'duplicate');
    return { kind: 'skipped', reason: 'duplicate' };
  }

  if (subjectObservation.anchor && subjectObservation.match) {
    await recordSubjectMatchObserved({
      workspaceId: retryTask.workspaceId,
      origin: 'webhook',
      reportingTaskId: newTask.id,
      anchor: subjectObservation.anchor,
      match: subjectObservation.match,
    });
  }
  await announceTaskCreated(newTask, workspace);
  await wakeTask(newTask.id, 'ci.retry');
  console.log(`Created CI retry task ${newTask.id} for failed PR #${prNumber} on ${repoFullName} (iteration ${retryTask.context.iteration})`);
  // ci_job_log evidence (byo-evidence-storage AC-3). After dispatch, and
  // never throws: evidence is diagnostics, the retry is the product.
  const captureEvidence = () => captureCiJobLogEvidence({
    installationId,
    repoFullName,
    failedJobId: ciLogs.failedJobId,
    workspaceId: retryTask.workspaceId,
    retryTaskId: newTask.id,
    parentTaskId: retryTask.parentTaskId,
    workerId: worker.id,
    prNumber,
  });
  try {
    after(captureEvidence);
  } catch {
    // Outside a request scope (tests, direct invocation, the cron) — run inline.
    await captureEvidence();
  }
  await appendPrActivity({
    installationId,
    repoFullName,
    prNumber,
    // Queued: the claim route writes `fix_started` once a worker has it.
    entry: {
      kind: 'ci_fixing',
      iteration: typeof retryTask.context.iteration === 'number' ? retryTask.context.iteration : null,
      maxIterations: typeof retryTask.context.maxIterations === 'number' ? retryTask.context.maxIterations : null,
      url: ciLogs.runUrl,
      taskUrl: taskActivityUrl(newTask.id),
    },
    workspaceId: retryTask.workspaceId,
  });
  // If the fix finishes without pushing, no CI event will bring this PR back.
  await lookAgain(skipCtx);
  return { kind: 'dispatched', taskId: newTask.id };
}
