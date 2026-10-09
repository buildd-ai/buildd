/**
 * On-demand PR review.
 *
 * `POST` hands a pull request to a reviewer agent — including a PR buildd did
 * not open, which is adopted as a task + worker first (see
 * `@/lib/pr-review-request`). `GET` reports where that review is, optionally
 * long-polling until it settles.
 *
 * The review then runs on exactly the same rails as a worker PR's review: the
 * verdict handler in `/api/workers/[id]`, the sticky activity comment, and
 * whatever the workspace's merge policy says about approvals.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces, missions, githubRepos } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkerPr, taskScopeAllowsWorkspace, taskScopeTaskLinksPr, type TaskScope } from '@/lib/task-token-auth';
import { getTeamWorkspaceIds } from '@/lib/team-access';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveSessionTeamIds, workspaceIdsForTeams } from '@/lib/session-team-scope';
import { resolveWorkspace } from '@/lib/workspace-resolver';
import { resolvePolicy } from '@/lib/merge-policy';
import { createReviewerTask, resolvePriorVerdict, type PriorVerdict } from '@/lib/reviewer';
import { carryForwardApprovalIfUnchanged } from '@/lib/approval-carry-forward';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { requestReview as requestKernelReview } from '@/lib/workflow/seam';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { isDependencyBotAuthor } from '@/lib/dependency-bot-pr';
import {
  findPrOwningWorker,
  findReviewTaskForPr,
  listWorkspaceRoles,
  resolveOrAdoptPrOwner,
  waitForPrReviewStatus,
} from '@/lib/pr-review-request';
import {
  derivePrReviewStatus,
  pickReviewerRole,
  MAX_REVIEW_WAIT_SECONDS,
  type PrReviewWaitFor,
} from '@/lib/pr-review-status';
import { requestingPerson } from '@/lib/request-person';

type Account = { id: string; teamId: string; taskScope?: TaskScope; sessionUserId?: string | null };

const FORCE_NEEDS_PERSON = 'force re-reviews a head that already has a verdict, which is a person\'s call: ask the owner, or re-review from the dashboard. Without force, a review is requested once the PR head moves.';

/**
 * Which workspaces a caller may resolve a PR in. An API key reaches its own
 * team, and a foreign workspace is refused (403) as it always was. A dashboard
 * session reaches the user's teams (or the one pinned by `teamId`), and a
 * foreign workspace simply does not exist for it (404).
 */
interface TargetScope {
  teamIds: string[];
  workspaceIds: () => Promise<string[]>;
  foreignWorkspace: 'forbidden' | 'not_found';
}

function accountScope(account: Account): TargetScope {
  // A per-task token sees only its own task's workspace, and anything outside
  // it as missing rather than forbidden.
  if (account.taskScope) {
    const workspaceId = account.taskScope.workspaceId;
    return { teamIds: [account.teamId], workspaceIds: async () => [workspaceId], foreignWorkspace: 'not_found' };
  }
  return {
    teamIds: [account.teamId],
    workspaceIds: () => getTeamWorkspaceIds(account.teamId),
    foreignWorkspace: 'forbidden',
  };
}

interface ResolvedTarget {
  workspace: {
    id: string;
    name: string;
    repo?: string | null;
    teamId: string;
    githubRepoId?: string | null;
    githubInstallationId?: string | null;
    gitConfig?: Record<string, unknown> | null;
    webhookConfig?: unknown;
  };
}

function bad(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

/**
 * Resolve which workspace owns the PR being reviewed.
 *
 * An explicit `workspaceId` (UUID, repo name, or `owner/repo`) always wins.
 * Without one: the workspace of the worker that already owns this PR, else the
 * team's single GitHub-linked workspace. Anything more ambiguous is an error
 * rather than a guess — reviewing in the wrong repo is not recoverable.
 */
async function resolveTarget(
  scope: TargetScope,
  prNumber: number,
  workspaceIdInput: string | null,
): Promise<ResolvedTarget | { error: string; status: number; candidates?: string[] }> {
  if (workspaceIdInput) {
    const ws = await resolveWorkspace(workspaceIdInput, { teamIds: scope.teamIds });
    if (!ws) return { error: `Workspace '${workspaceIdInput}' not found`, status: 404 };
    if (!scope.teamIds.includes(ws.teamId)) {
      return scope.foreignWorkspace === 'forbidden'
        ? { error: 'Workspace belongs to a different team', status: 403 }
        : { error: `Workspace '${workspaceIdInput}' not found`, status: 404 };
    }
    return { workspace: ws as ResolvedTarget['workspace'] };
  }

  const wsIds = await scope.workspaceIds();
  if (wsIds.length === 0) return { error: 'No workspaces found for account', status: 403 };

  const owning = await db.query.workers.findFirst({
    where: and(eq(workers.prNumber, prNumber), inArray(workers.workspaceId, wsIds)),
    columns: { workspaceId: true },
  });
  if (owning?.workspaceId) {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, owning.workspaceId) });
    if (ws) return { workspace: ws as ResolvedTarget['workspace'] };
  }

  const linked = await db.query.workspaces.findMany({
    where: and(inArray(workspaces.id, wsIds), isNotNull(workspaces.githubRepoId)),
  });
  if (linked.length === 1) return { workspace: linked[0] as ResolvedTarget['workspace'] };
  return {
    error:
      linked.length === 0
        ? 'No GitHub-linked workspace found for this account'
        : `Several GitHub-linked workspaces — pass workspaceId to say which repo PR #${prNumber} is in`,
    status: 400,
    candidates: linked.map((w) => w.name),
  };
}

/** The GitHub repo + installation behind a workspace. */
async function resolveRepo(workspace: ResolvedTarget['workspace']) {
  if (!workspace.githubRepoId || !workspace.githubInstallationId) return null;
  const repo = await db.query.githubRepos.findFirst({
    where: eq(githubRepos.id, workspace.githubRepoId),
    with: { installation: true },
  });
  if (!repo?.installation) return null;
  return { fullName: repo.fullName as string, installationId: repo.installation.installationId as number };
}

/**
 * Would buildd itself merge this PR once the reviewer approves?
 *
 * Mirrors the verdict handler: `approve-only` leaves the merge to a human, and
 * a `human` tier never auto-merges. Surfaced to the caller so a merge-waiter
 * knows whether waiting is pointless.
 */
function autoMergeExpectedFor(policy: { tier: string; agentReview?: { gateCondition?: string } }): boolean {
  if (policy.tier === 'human') return false;
  return policy.agentReview?.gateCondition !== 'approve-only';
}

async function resolveEffectivePolicy(
  workspace: ResolvedTarget['workspace'],
  missionId: string | null,
) {
  const mission = missionId
    ? await db.query.missions.findFirst({ where: eq(missions.id, missionId), columns: { mergePolicy: true } })
    : null;
  return resolvePolicy(workspace as never, mission as never);
}

export async function POST(req: NextRequest) {
  // A per-task token may ask for review only of its own task's PR.
  const account = await authenticateTaskScopedCaller(req.headers.get('authorization')?.replace('Bearer ', '') || null, req);
  if (!account) return bad('Invalid API key', 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return bad('Invalid JSON body', 400);
  }

  const prNumber = Number(body.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return bad('prNumber is required and must be a positive integer', 400);
  }

  const callbackUrl = typeof body.callbackUrl === 'string' ? body.callbackUrl : null;
  if (callbackUrl && !callbackUrl.startsWith('https://')) {
    return bad('callbackUrl must be an https URL — a verdict is never posted in the clear', 400);
  }
  const callbackOn: PrReviewWaitFor = body.callbackOn === 'merge' ? 'merge' : 'verdict';

  const target = await resolveTarget(
    accountScope(account as Account),
    prNumber,
    typeof body.workspaceId === 'string' ? body.workspaceId : null,
  );
  if ('error' in target) return bad(target.error, target.status, target.candidates ? { candidates: target.candidates } : {});
  const { workspace } = target;

  const repo = await resolveRepo(workspace);
  if (!repo) return bad('Workspace is not linked to a GitHub repo', 400);

  // Read the PR before touching any state — a wrong number, a PR in another
  // repo, or an already-closed PR must not leave an adopted task behind.
  let pr: any;
  try {
    pr = await githubApi(repo.installationId, `/repos/${repo.fullName}/pulls/${prNumber}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('404') ? 404 : 502;
    return bad(`Could not read PR #${prNumber} on ${repo.fullName}: ${message}`, status);
  }
  if (!pr?.number) return bad(`PR #${prNumber} not found on ${repo.fullName}`, 404);
  if (pr.state !== 'open') {
    return bad(`PR #${prNumber} is ${pr.merged ? 'merged' : pr.state} — only an open PR can be reviewed`, 409, {
      prState: pr.merged ? 'merged' : pr.state,
    });
  }

  const existingWorker = await findPrOwningWorker(workspace.id, prNumber);
  const ownsViaWorker = !!existingWorker && taskScopeAllowsWorkerPr(account, { ...existingWorker, prNumber }, prNumber);
  // Or a PR the token's OWN task's records link (a coordination task repairing a PR it never opened),
  // never one the owner's task links (§17.1 of docs/specs/workflow-state-kernel.md).
  if (account.taskScope && !ownsViaWorker && !(await taskScopeTaskLinksPr(account, { workspaceId: account.taskScope.workspaceId, prNumber }))) {
    return bad('A task token may request review only of its own PR, or one its task\'s records link', 403);
  }

  // A PR the workflow kernel owns is reviewed only in kernel rounds: the request
  // is T5 (ReviewRequested) against the live head. `force` re-reviews a head
  // that already has a verdict; it never stacks a second reviewer on a round.
  const person = requestingPerson(null, account);
  const kernel = await requestKernelReview({
    workspaceId: workspace.id, repoFullName: repo.fullName, prNumber, installationId: repo.installationId,
    forced: body.force === true, actor: person ? `human:${person}` : `agent:${account.id}`,
  }).catch((err) => {
    console.error(`[pr-review] workflow kernel review request failed for PR #${prNumber}:`, err);
    return null;
  });
  if (kernel?.handled) {
    const r = kernel.result;
    const accepted = r.result === 'applied'
      || (r.result === 'rejected' && (r.reason === 'review_in_flight' || r.reason === 'head_already_reviewed'));
    if (!accepted) {
      return bad(`Review not requested: ${r.reason}`, 409, {
        code: r.reason, current: r.current, kernel: true,
        ...(r.reason === 'force_requires_human' ? { hint: FORCE_NEEDS_PERSON } : {}),
        ...(r.reason === 'escalation_needs_human' ? { hint: 'this PR is escalated to a person for a reason another review does not answer; the owner resolves it from the dashboard' } : {}),
      });
    }
    // §8.1: the reviewer that answers is the round's at the live head, never the
    // newest reviewer row of the PR number (§14 Slice A retired that rule here).
    const latest = kernel.reviewTaskId
      ? (await db.query.tasks.findFirst({
          where: eq(tasks.id, kernel.reviewTaskId),
          columns: { id: true, status: true, result: true, context: true },
        })) ?? null
      : null;
    if (latest && callbackUrl && r.result === 'applied') {
      await db.update(tasks)
        .set({ context: sql`COALESCE(${tasks.context}, '{}'::jsonb) || jsonb_build_object('reviewCallback', ${JSON.stringify({ url: callbackUrl, on: callbackOn })}::jsonb)` })
        .where(eq(tasks.id, latest.id));
    }
    const kernelPolicy = await resolveEffectivePolicy(workspace, null);
    return NextResponse.json({
      ok: true,
      kernel: true,
      alreadyRequested: r.result !== 'applied',
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
  const force = body.force === true;

  // A forced re-review of the head that already has a verdict is a person's
  // call here too. An agent may force a review of a head nobody has judged yet
  // (the head moved, or the last reviewer left no verdict).
  if (force && !person && !inFlight) {
    const prior = resolvePriorVerdict(existingReview);
    if (prior && prior.headSha === (pr.head?.sha ?? '')) {
      return bad('Review not requested: force_requires_human', 409, { code: 'force_requires_human', hint: FORCE_NEEDS_PERSON });
    }
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
      surface: 'POST /api/github/pr/review',
      outcome: 'deferred',
      reason: inFlight
        ? 'a reviewer is already working this PR'
        : 'this PR already has a review; pass force to re-review',
      workspaceId: workspace.id,
      taskId: existingWorker?.taskId ?? null,
      workerId: existingWorker?.id ?? null,
      callerOrigin: 'api',
      detail: { prNumber, inFlight, force, reviewTaskId: existingReview.id },
    });
    return NextResponse.json({
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
      return NextResponse.json({
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
    creationSource: 'mcp',
    accountId: account.id,
  });

  // Automatic adoption skips dependency-bot PRs; an explicit request is the
  // one door that adopts them. Recorded as a bypass so the ledger shows how
  // often that happens. The push paths still refuse the bot's branch.
  if (adopted && isDependencyBotAuthor(pr.user)) {
    fireGateEvent({
      gate: GATE_SLUGS.DEPENDENCY_BOT_PR,
      surface: 'POST /api/github/pr/review',
      outcome: 'bypassed',
      reason: 'explicit review request adopted a dependency-bot PR — reviewed, never pushed to',
      workspaceId: workspace.id,
      taskId: ownerWorker.taskId,
      workerId: ownerWorker.id,
      callerOrigin: 'api',
      detail: { prNumber, author: pr.user?.login ?? null, stage: 'adoption' },
    });
  }

  const policy = await resolveEffectivePolicy(workspace, originalTask.missionId);
  const roles = await listWorkspaceRoles(workspace.id, account.teamId);
  const picked = pickReviewerRole({
    requested: typeof body.reviewerRole === 'string' ? body.reviewerRole : null,
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

  if (!reviewerTask?.id) return bad('Could not create the reviewer task', 500);

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
  return NextResponse.json(
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

// Auth: API key, or the dashboard session (GET only — POST dispatches a
// reviewer and stays key-only). A session resolves within the user's teams, or
// just `teamId` when given; anything outside 404s. A key, when present, is
// authoritative and `teamId` is ignored.
export async function GET(req: NextRequest) {
  // A per-task token reads reviews only in its own task's workspace (accountScope).
  const account = await authenticateTaskScopedCaller(req.headers.get('authorization')?.replace('Bearer ', '') || null, req);
  const sessionUser = account ? null : await getCurrentUser();
  if (!account && !sessionUser) return bad('Invalid API key', 401);

  const url = new URL(req.url);
  const prNumber = Number(url.searchParams.get('prNumber'));
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return bad('prNumber is required and must be a positive integer', 400);
  }

  let scope: TargetScope;
  if (account) {
    scope = accountScope(account as Account);
  } else {
    const teamIds = await resolveSessionTeamIds(sessionUser!.id, url.searchParams.get('teamId'));
    if (!teamIds) return bad('Team not found', 404);
    scope = { teamIds, workspaceIds: () => workspaceIdsForTeams(teamIds), foreignWorkspace: 'not_found' };
  }

  const target = await resolveTarget(scope, prNumber, url.searchParams.get('workspaceId'));
  if ('error' in target) return bad(target.error, target.status, target.candidates ? { candidates: target.candidates } : {});
  const { workspace } = target;
  if (account && !taskScopeAllowsWorkspace(account, workspace.id)) return bad('PR not found', 404);

  const waitFor: PrReviewWaitFor = url.searchParams.get('waitFor') === 'merge' ? 'merge' : 'verdict';
  const requestedWait = Number(url.searchParams.get('waitSeconds') ?? 0);
  const waitSeconds = Number.isFinite(requestedWait)
    ? Math.min(Math.max(requestedWait, 0), MAX_REVIEW_WAIT_SECONDS)
    : 0;

  const owningWorker = await findPrOwningWorker(workspace.id, prNumber);
  const task = owningWorker?.taskId
    ? await db.query.tasks.findFirst({ where: eq(tasks.id, owningWorker.taskId), columns: { missionId: true } })
    : null;
  const policy = await resolveEffectivePolicy(workspace, task?.missionId ?? null);
  const autoMergeExpected = autoMergeExpectedFor(policy);

  const { status, timedOut } = await waitForPrReviewStatus({
    workspaceId: workspace.id,
    prNumber,
    autoMergeExpected,
    waitFor,
    waitSeconds,
  });

  return NextResponse.json({
    ok: true,
    prNumber,
    workspaceId: workspace.id,
    waitFor,
    autoMergeExpected,
    timedOut,
    status,
  });
}
