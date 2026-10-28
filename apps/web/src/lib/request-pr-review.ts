/**
 * The core of "buildd, review this PR": the request path behind `POST
 * /api/github/pr/review` (the `request_pr_review` MCP action), with the caller
 * already resolved. Shared by that route and by the PR webhook's auto-review of
 * a PR buildd did not open (`lib/auto-review-unowned.ts`), so both go through
 * one door: a kernel-owned PR is a kernel round (T5), any other PR is adopted
 * as a task + worker (`resolveOrAdoptPrOwner`) and handed to a reviewer agent,
 * after which the verdict handler and the workspace merge policy apply.
 *
 * One reviewer per PR at a time, and a forced re-review of a head that already
 * has a verdict stays a person's call: both are decided here, for every caller.
 */
import { db } from '@buildd/core/db';
import { tasks, missions } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { GateCallerOrigin } from '@buildd/core/gate-events';
import { resolvePolicy } from '@/lib/merge-policy';
import { createReviewerTask, resolvePriorVerdict, type PriorVerdict } from '@/lib/reviewer';
import { carryForwardApprovalIfUnchanged } from '@/lib/approval-carry-forward';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { doorErrorResponse, isDoorError, requestReview as requestKernelReview } from '@/lib/workflow/kernel-client';
import type { KernelPrincipal } from '@/lib/workflow/command-api';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { isDependencyBotAuthor } from '@/lib/dependency-bot-pr';
import {
  findPrOwningWorker,
  findReviewTaskForPr,
  findLiveReviewTaskForPr,
  listWorkspaceRoles,
  resolveOrAdoptPrOwner,
} from '@/lib/pr-review-request';
import {
  derivePrReviewStatus,
  isReviewBudgetSpent,
  pickReviewerRole,
  type PrReviewWaitFor,
} from '@/lib/pr-review-status';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { decisionRefusalReason } from '@buildd/workflow-kernel/decision-refusal';

/**
 * 2ded4e88: the review rounds are spent and the PR waits on a person. Says where a person acts
 * rather than "pass force": an interactive session reading the hint would just retry with it.
 */
const REVIEW_BUDGET_SPENT_HINT = 'the review rounds for this PR are spent and it waits on a person; a person can request one more review from the PR\'s page, or approve it';
const FORCE_NEEDS_PERSON = 'force re-reviews a head that already has a verdict, which is a person\'s call: ask the owner, or re-review from the dashboard. Without force, a review is requested once the PR head moves.';

/** The workspace a PR is reviewed in (the columns the request path reads). */
export interface ReviewWorkspace {
  id: string;
  name: string;
  repo?: string | null;
  teamId: string;
  githubRepoId?: string | null;
  githubInstallationId?: string | null;
  gitConfig?: Record<string, unknown> | null;
  webhookConfig?: unknown;
}

/** Who asks, as the request path records and authorizes it. */
export interface ReviewRequester {
  /** The person behind the request, if any: only a person may force a re-review of a judged head. */
  person: string | null;
  /** The kernel command's actor (`human:<id>`, `agent:<account>`, `system:...`). */
  actor: string;
  principal: KernelPrincipal | null;
  /** Stamped on an adopted PR's worker; null for buildd's own requests. */
  accountId: string | null;
  /** Whose roles may run the review. */
  teamId: string;
  creationSource: 'mcp' | 'webhook' | 'dashboard';
  /** The gate ledger's surface and caller origin for this door. */
  surface: string;
  origin: GateCallerOrigin;
}

export interface RequestPrReviewInput {
  workspace: ReviewWorkspace;
  repo: { fullName: string; installationId: number };
  /** The PR as GitHub returned it, already checked open. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pr: any;
  prNumber: number;
  requester: ReviewRequester;
  force?: boolean;
  reviewerRole?: string | null;
  callbackUrl?: string | null;
  callbackOn?: PrReviewWaitFor;
  /** The worker that owns the PR, when the caller already read it (undefined: read here). */
  existingWorker?: Awaited<ReturnType<typeof findPrOwningWorker>> | null;
}

/** The answer, as JSON for a route to return (or a kernel door's own error response). */
export type RequestPrReviewResult =
  | { kind: 'json'; status: number; body: Record<string, unknown> }
  | { kind: 'response'; response: Response };

function reply(body: Record<string, unknown>, init?: { status?: number }): RequestPrReviewResult {
  return { kind: 'json', status: init?.status ?? 200, body };
}

function bad(error: string, status: number, extra: Record<string, unknown> = {}): RequestPrReviewResult {
  return { kind: 'json', status, body: { error, ...extra } };
}

/**
 * Would buildd itself merge this PR once the reviewer approves?
 *
 * Mirrors the verdict handler: `approve-only` leaves the merge to a human, and
 * a `human` tier never auto-merges. Surfaced to the caller so a merge-waiter
 * knows whether waiting is pointless.
 */
export function autoMergeExpectedFor(policy: { tier: string; agentReview?: { gateCondition?: string } }): boolean {
  if (policy.tier === 'human') return false;
  return policy.agentReview?.gateCondition !== 'approve-only';
}

export async function resolveEffectivePolicy(
  workspace: ReviewWorkspace,
  missionId: string | null,
) {
  const mission = missionId
    ? await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, missionId)), columns: { mergePolicy: true } })
    : null;
  return resolvePolicy(workspace as never, mission as never);
}

/** Request a review of an open PR (see the module doc). */
export async function requestPrReview(input: RequestPrReviewInput): Promise<RequestPrReviewResult> {
  const { workspace, repo, pr, prNumber, requester } = input;
  const person = requester.person;
  const callbackUrl = input.callbackUrl ?? null;
  const callbackOn: PrReviewWaitFor = input.callbackOn ?? 'verdict';
  const existingWorker = input.existingWorker !== undefined ? input.existingWorker : await findPrOwningWorker(workspace.id, prNumber);


  // A PR the workflow kernel owns is reviewed only in kernel rounds: the request
  // is T5 (ReviewRequested) against the live head. `force` re-reviews a head
  // that already has a verdict; it never stacks a second reviewer on a round.
  const kernel = await requestKernelReview({
    workspaceId: workspace.id, repoFullName: repo.fullName, prNumber, installationId: repo.installationId,
    forced: input.force === true, actor: requester.actor,
    ...(callbackUrl ? { reviewCallback: { url: callbackUrl, on: callbackOn } } : {}),
  }, { principal: requester.principal }).catch((err) => {
    // An unreachable control plane is not a reason to queue a legacy review beside the kernel's.
    if (isDoorError(err)) return err;
    console.error(`[pr-review] workflow kernel review request failed for PR #${prNumber}:`, err);
    return null;
  });
  if (isDoorError(kernel)) return { kind: 'response', response: doorErrorResponse(kernel) };
  // §8.1: the reviewer that answers is the round's at the live head, never the
  // newest reviewer row of the PR number (§14 Slice A retired that rule here).
  // A reviewTaskId whose row is gone is no review task at all: fall through and
  // queue one rather than report "already under review" with no status.
  const kernelReviewTask = kernel?.handled && kernel.reviewTaskId
    ? (await db.query.tasks.findFirst({
        where: sqlWhere(eq(tasks.id, kernel.reviewTaskId)),
        columns: { id: true, status: true, result: true, context: true },
      })) ?? null
    : null;
  // Only an accepted result may fall through: a refusal (escalation, force) keeps its 409.
  const kernelAccepted = !!kernel?.handled && (kernel.result.result === 'applied'
    || (kernel.result.result === 'rejected' && (kernel.result.reason === 'review_in_flight' || kernel.result.reason === 'head_already_reviewed')));
  const kernelReviewTaskMissing = kernelAccepted && !!kernel?.reviewTaskId && !kernelReviewTask;
  if (kernel?.handled && !kernelReviewTaskMissing) {
    const r = kernel.result;
    const accepted = kernelAccepted;
    if (!accepted && r.result !== 'applied') {
      return bad(`Review not requested: ${decisionRefusalReason(r.reason)}`, 409, {
        code: r.reason, current: r.current, kernel: true,
        ...(r.reason === 'force_requires_human' ? { hint: FORCE_NEEDS_PERSON } : {}),
        ...(r.reason === 'escalation_needs_human' ? { hint: 'this PR is escalated to a person for a reason another review does not answer; the owner resolves it from the dashboard' } : {}),
        ...(r.reason === 'review_budget_spent' ? { hint: REVIEW_BUDGET_SPENT_HINT } : {}),
      });
    }
    const latest = kernelReviewTask;
    if (latest && callbackUrl && r.result === 'applied') {
      await db.update(tasks)
        .set({ context: sql`COALESCE(${tasks.context}, '{}'::jsonb) || jsonb_build_object('reviewCallback', ${JSON.stringify({ url: callbackUrl, on: callbackOn })}::jsonb)` })
        .where(eq(tasks.id, latest.id));
    }
    const kernelPolicy = await resolveEffectivePolicy(workspace, null);
    // 1bd26ae7: never "already under review" with nothing behind it. A round with no reviewer task
    // yet says so, with the live head it is for; the seam has re-queued its dispatch when every
    // earlier one finished without filing a reviewer.
    const noReviewer = !latest
      ? { state: 'queued' as const, headSha: (pr.head?.sha as string | undefined) ?? null, reason: r.result === 'applied'
          ? 'a review round is queued at this head; buildd is filing its reviewer now'
          : `no reviewer task exists for this head yet (${r.reason})` }
      : null;
    return reply({
      ok: true,
      kernel: true,
      alreadyRequested: r.result !== 'applied',
      ...(noReviewer ? { queued: noReviewer } : {}),
      ...(r.result === 'rejected' && r.reason === 'head_already_reviewed'
        ? { hint: person ? 'this head already has a verdict; pass force to re-review' : 'this head already has a verdict; a new round starts when the PR head moves (a forced re-review is a person\'s call)' }
        : {}),
      prNumber,
      reviewTaskId: latest?.id ?? null,
      taskId: existingWorker?.taskId ?? null,
      autoMergeExpected: autoMergeExpectedFor(kernelPolicy),
      callback: callbackUrl && r.result === 'applied' ? { url: callbackUrl, on: callbackOn } : null,
      status: latest
        ? derivePrReviewStatus({ reviewTask: latest, worker: existingWorker ?? null, autoMergeExpected: autoMergeExpectedFor(kernelPolicy) })
        : null,
    }, { status: r.result === 'applied' ? 201 : 200 });
  }
  const existingReview = await findReviewTaskForPr(workspace.id, prNumber);
  const inFlight = existingReview?.status === 'pending' || existingReview?.status === 'in_progress';
  const force = input.force === true;

  // A forced re-review of the head that already has a verdict is a person's
  // call here too. An agent may force a review of a head nobody has judged yet
  // (the head moved, or the last reviewer left no verdict).
  if (force && !person && !inFlight) {
    const prior = resolvePriorVerdict(existingReview);
    if (prior && prior.headSha === (pr.head?.sha ?? '')) {
      return bad(`Review not requested: ${decisionRefusalReason('force_requires_human')}`, 409, { code: 'force_requires_human', hint: FORCE_NEEDS_PERSON });
    }
  }

  // 2ded4e88: the round budget is the PR's. Spent, force does not file a reviewer from here, at the
  // judged head or a moved one; a person asks from the PR's page (the dashboard re-review route).
  if (force && !inFlight && existingReview
    && isReviewBudgetSpent(derivePrReviewStatus({ reviewTask: existingReview, worker: existingWorker ?? null, autoMergeExpected: false }))) {
    return bad(`Review not requested: ${decisionRefusalReason('review_budget_spent')}`, 409, { code: 'review_budget_spent', hint: REVIEW_BUDGET_SPENT_HINT });
  }

  // Idempotency: one reviewer per PR at a time. `force` re-reviews a finished
  // review but never stacks a second agent onto a running one — two reviewers
  // on one PR race each other's verdicts.
  if (existingReview && (inFlight || !force)) {
    const policy = await resolveEffectivePolicy(workspace, null);
    // Deferred, not rejected: the caller's request is honoured by the reviewer
    // already running. The count answers "how often is a second review asked
    // for", which is the signal that a review is stuck without failing.
    fireGateEvent({
      gate: GATE_SLUGS.REVIEWER_SINGLE_FLIGHT,
      surface: requester.surface,
      outcome: 'deferred',
      reason: inFlight
        ? 'a reviewer is already working this PR'
        : 'this PR already has a review; pass force to re-review',
      workspaceId: workspace.id,
      taskId: existingWorker?.taskId ?? null,
      workerId: existingWorker?.id ?? null,
      callerOrigin: requester.origin,
      detail: { prNumber, inFlight, force, reviewTaskId: existingReview.id },
    });
    return reply({
      ok: true,
      alreadyRequested: true,
      prNumber,
      reviewTaskId: existingReview.id,
      taskId: existingWorker?.taskId ?? null,
      autoMergeExpected: autoMergeExpectedFor(policy),
      status: derivePrReviewStatus({
        reviewTask: existingReview,
        worker: existingWorker ?? null,
        autoMergeExpected: autoMergeExpectedFor(policy),
      }),
    });
  }

  // A force re-review of a PR that already carries a terminal verdict at a
  // DIFFERENT head is a delta review: the reviewer gets the delta plus its
  // own prior verdict instead of re-reading the whole PR. Same head (or no
  // recorded verdict) falls through to the full review below unchanged.
  const priorVerdict: PriorVerdict | undefined = force
    ? (resolvePriorVerdict(existingReview) ?? undefined)
    : undefined;
  const deltaPriorVerdict = priorVerdict && priorVerdict.headSha !== (pr.head?.sha ?? '')
    ? priorVerdict
    : undefined;

  // An approval whose PR diff is unchanged since it was given (the head only
  // moved by a rebase or base merge) needs no second agent: record that it
  // covers the new head and return it, instead of paying for a delta review
  // of an empty delta. Only an approve carries forward.
  if (existingReview && deltaPriorVerdict?.verdict === 'approve' && pr.base?.ref && pr.head?.sha) {
    const carry = await carryForwardApprovalIfUnchanged({
      installationId: repo.installationId,
      repoFullName: repo.fullName,
      workspaceId: workspace.id,
      prNumber,
      baseRef: pr.base.ref,
      headSha: pr.head.sha,
    }).catch((err) => {
      console.warn(`[pr-review] carry-forward check failed for PR #${prNumber}:`, err);
      return { carried: false, reason: 'carry-forward check failed' };
    });
    if (carry.carried) {
      const policy = await resolveEffectivePolicy(workspace, null);
      return reply({
        ok: true,
        alreadyRequested: true,
        carriedForward: true,
        carriedForwardReason: carry.reason,
        prNumber,
        reviewTaskId: existingReview.id,
        taskId: existingWorker?.taskId ?? null,
        autoMergeExpected: autoMergeExpectedFor(policy),
        status: derivePrReviewStatus({
          reviewTask: existingReview,
          worker: existingWorker ?? null,
          autoMergeExpected: autoMergeExpectedFor(policy),
        }),
      });
    }
  }

  // Adopt the PR when buildd has no worker for it: every downstream surface
  // keys off "the worker that owns this PR", so adoption is what lets an
  // externally-authored PR use the existing review rails unchanged.
  const { adopted, ownerWorker, originalTask } = await resolveOrAdoptPrOwner({
    workspaceId: workspace.id,
    installationId: repo.installationId,
    repoFullName: repo.fullName,
    prNumber,
    pr,
    creationSource: requester.creationSource,
    accountId: requester.accountId,
  });

  // Automatic adoption skips dependency-bot PRs; an explicit request is the
  // one door that adopts them. Recorded as a bypass so the ledger shows how
  // often that happens. The push paths still refuse the bot's branch.
  if (adopted && isDependencyBotAuthor(pr.user)) {
    fireGateEvent({
      gate: GATE_SLUGS.DEPENDENCY_BOT_PR,
      surface: requester.surface,
      outcome: 'bypassed',
      reason: 'explicit review request adopted a dependency-bot PR — reviewed, never pushed to',
      workspaceId: workspace.id,
      taskId: ownerWorker.taskId,
      workerId: ownerWorker.id,
      callerOrigin: requester.origin,
      detail: { prNumber, author: pr.user?.login ?? null, stage: 'adoption' },
    });
  }

  const policy = await resolveEffectivePolicy(workspace, originalTask.missionId);
  const roles = await listWorkspaceRoles(workspace.id, requester.teamId);
  const picked = pickReviewerRole({
    requested: input.reviewerRole ?? null,
    policyRole: policy.agentReview?.reviewerRole ?? null,
    available: roles,
  });
  if (!picked.role) return bad(picked.error ?? 'No reviewer role available', 400);

  const reviewerTask = await createReviewerTask({
    workspaceId: workspace.id,
    originalTaskId: originalTask.id,
    originalTask: {
      title: originalTask.title,
      description: originalTask.description,
      backend: originalTask.backend,
      missionId: originalTask.missionId,
      pathManifest: originalTask.pathManifest ?? null,
      iteration: originalTask.iteration ?? 0,
      maxIterations: originalTask.maxIterations ?? 3,
    },
    worker: { branch: ownerWorker!.branch ?? `pr-${prNumber}` },
    prNumber,
    prUrl: pr.html_url,
    headSha: pr.head?.sha ?? '',
    reviewerRole: picked.role,
    confidenceThreshold: policy.agentReview?.maxConfidenceThreshold,
    installationId: repo.installationId,
    repoFullName: repo.fullName,
    policyConfig: (workspace.gitConfig as any)?.policyConfig,
    // Already fetched — the reviewer reads it for its lede only.
    prBody: typeof pr.body === 'string' ? pr.body : null,
    baseRef: typeof pr.base?.ref === 'string' ? pr.base.ref : null,
    ...(callbackUrl ? { reviewCallback: { url: callbackUrl, on: callbackOn } } : {}),
    ...(deltaPriorVerdict ? { priorVerdict: deltaPriorVerdict } : {}),
  });

  if (!reviewerTask?.id) {
    // This may occur if a concurrent caller (e.g., create_pr's auto-review
    // request and the explicit review request in the same milliseconds) both
    // tried to create a reviewer task for the same PR. The first wins due to
    // the DB constraint; if the winner was not found by the fallback lookup
    // in createReviewerTask, try a broader lookup as a last resort.
    console.warn(`[pr-review] createReviewerTask returned null for PR #${prNumber}; attempting fallback lookup`);

    // Retry with a live-task-only lookup that doesn't require head SHA match.
    // This catches cases where the concurrent winner was created just after
    // our insert failed but before we found it. Only returns pending/assigned/in_progress
    // tasks — never completed ones from prior heads.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const fallback = await findLiveReviewTaskForPr(workspace.id, prNumber);
      if (fallback?.id) {
        console.log(`[pr-review] Fallback lookup found live reviewer task ${fallback.id} for PR #${prNumber}`);
        const policy = await resolveEffectivePolicy(workspace, originalTask.missionId);
        return reply(
          {
            ok: true,
            adopted,
            alreadyRequested: true,
            prNumber,
            prUrl: pr.html_url,
            repoFullName: repo.fullName,
            workspaceId: workspace.id,
            taskId: originalTask.id,
            reviewTaskId: fallback.id,
            deduplicated: true,
            reviewerRole: picked.role,
            reviewerRoleSource: picked.source,
            autoMergeExpected: autoMergeExpectedFor(policy),
            callback: callbackUrl ? { url: callbackUrl, on: callbackOn } : null,
            status: derivePrReviewStatus({
              reviewTask: fallback as any,
              worker: ownerWorker ?? null,
              autoMergeExpected: autoMergeExpectedFor(policy),
            }),
          },
          { status: 200 },
        );
      }
    }

    console.error(`[pr-review] Failed to create or find reviewer task for PR #${prNumber} in workspace ${workspace.id}`);
    return bad('Could not create the reviewer task (or find concurrent writer; see logs)', 500);
  }

  // A live reviewer task already owns this PR generation — return it rather than
  // putting a second agent on the same commit. Dispatch and the PR activity
  // entry both belong to the filing that won.
  if (!reviewerTask.deduplicated) {
    await announceTaskCreated(
      {
        id: reviewerTask.id,
        title: `Review PR #${prNumber}: ${originalTask.title}`,
        description: null,
        workspaceId: workspace.id,
        missionId: originalTask.missionId,
        backend: originalTask.backend,
        roleSlug: picked.role,
      },
      workspace as never,
    );
    await wakeTask(reviewerTask.id, 'task.created');

    // Say so on the PR itself, exactly as the webhook path does.
    await appendPrActivity({
      installationId: repo.installationId,
      repoFullName: repo.fullName,
      prNumber,
      entry: { kind: 'review_queued' },
      workspaceId: workspace.id,
    });
  }

  const autoMergeExpected = autoMergeExpectedFor(policy);
  return reply(
    {
      ok: true,
      adopted,
      prNumber,
      prUrl: pr.html_url,
      repoFullName: repo.fullName,
      workspaceId: workspace.id,
      taskId: originalTask.id,
      reviewTaskId: reviewerTask.id,
      deduplicated: reviewerTask.deduplicated ?? false,
      reviewerRole: picked.role,
      reviewerRoleSource: picked.source,
      autoMergeExpected,
      callback: callbackUrl ? { url: callbackUrl, on: callbackOn } : null,
      status: derivePrReviewStatus({
        reviewTask: { id: reviewerTask.id, status: 'pending', result: null, context: { prNumber } },
        worker: ownerWorker ?? null,
        autoMergeExpected,
      }),
    },
    { status: 201 },
  );
}
