/**
 * On-demand PR review.
 *
 * `POST` hands a pull request to a reviewer agent — including a PR buildd did
 * not open, which is adopted as a task + worker first (see
 * `@/lib/request-pr-review`, shared with the PR webhook's auto-review). `GET` reports where that review is, optionally
 * long-polling until it settles.
 *
 * The review then runs on exactly the same rails as a worker PR's review: the
 * verdict handler in `/api/workers/[id]`, the sticky activity comment, and
 * whatever the workspace's merge policy says about approvals.
 */

import { NextRequest, NextResponse } from 'next/server';
import { constrainToGranted, type GrantScopedAccount } from '@/lib/grant-scope';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces, githubRepos } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkerPr, taskScopeAllowsWorkspace, taskScopeTaskLinksPr, taskScopeHoldsWorkspaceReviewReach, type TaskScope } from '@/lib/task-token-auth';
import { getTeamWorkspaceIds } from '@/lib/team-access';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveSessionTeamIds, workspaceIdsForTeams } from '@/lib/session-team-scope';
import { resolveWorkspace } from '@/lib/workspace-resolver';
import { kernelPrincipalOf } from '@/lib/workflow/kernel-client';
import { findPrOwningWorker, waitForPrReviewStatus } from '@/lib/pr-review-request';
import { MAX_REVIEW_WAIT_SECONDS, type PrReviewWaitFor } from '@/lib/pr-review-status';
import { autoMergeExpectedFor, requestPrReview, resolveEffectivePolicy } from '@/lib/request-pr-review';
import { requestingPerson } from '@/lib/request-person';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { getDeliveryViewsForTasks } from '@/lib/workflow/delivery-view';

type Account = { id: string; teamId: string; taskScope?: TaskScope; sessionUserId?: string | null } & GrantScopedAccount;

/**
 * Which workspaces a caller may resolve a PR in. An API key reaches its own
 * team, and a foreign workspace is refused (403) as it always was. A dashboard
 * session reaches the user's teams (or the one pinned by `teamId`), and a
 * foreign workspace simply does not exist for it (404).
 */
interface TargetScope {
  teamIds: string[];
  workspaceIds: () => Promise<string[]>;
  /** A per-task token's one workspace: a name or repo is matched against it directly. */
  ownWorkspaceId?: string;
  foreignWorkspace: 'forbidden' | 'not_found';
}

function accountScope(account: Account): TargetScope {
  // A per-task token sees only its own task's workspace, and anything outside
  // it as missing rather than forbidden.
  if (account.taskScope) {
    const workspaceId = account.taskScope.workspaceId;
    return { teamIds: [account.teamId], workspaceIds: async () => [workspaceId], ownWorkspaceId: workspaceId, foreignWorkspace: 'not_found' };
  }
  return {
    teamIds: [account.teamId],
    // A grant session or a workspace-restricted key: only what it may reach.
    workspaceIds: async () => constrainToGranted(account, await getTeamWorkspaceIds(account.teamId)),
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
    // A task token's workspace may not be owned by its team, so the team-wide
    // lookup would miss it. Match the input against that one workspace instead.
    if (scope.ownWorkspaceId) {
      const own = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, scope.ownWorkspaceId)) });
      const lower = workspaceIdInput.toLowerCase();
      const matches = !!own && (
        own.id === workspaceIdInput ||
        own.name.toLowerCase() === lower ||
        own.repo?.toLowerCase() === lower ||
        !!own.repo?.toLowerCase().endsWith('/' + lower)
      );
      if (own && matches) return { workspace: own as ResolvedTarget['workspace'] };
    }
    const ws = await resolveWorkspace(workspaceIdInput, { teamIds: scope.teamIds });
    if (!ws) return { error: `Workspace '${workspaceIdInput}' not found`, status: 404 };
    if (!scope.teamIds.includes(ws.teamId)) {
      return scope.foreignWorkspace === 'forbidden'
        ? { error: 'Workspace belongs to a different team', status: 403 }
        : { error: `Workspace '${workspaceIdInput}' not found`, status: 404 };
    }
    // In the team is necessary, not sufficient: a grant session or a
    // workspace-restricted key reaches only its own list.
    if (!(await scope.workspaceIds()).includes(ws.id)) return { error: `Workspace '${workspaceIdInput}' not found`, status: 404 };
    return { workspace: ws as ResolvedTarget['workspace'] };
  }

  const wsIds = await scope.workspaceIds();
  if (wsIds.length === 0) return { error: 'No workspaces found for account', status: 403 };

  const owning = await db.query.workers.findFirst({
    where: sqlWhere(and(eq(workers.prNumber, prNumber), inArray(workers.workspaceId, wsIds))),
    columns: { workspaceId: true },
  });
  if (owning?.workspaceId) {
    const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, owning.workspaceId)) });
    if (ws) return { workspace: ws as ResolvedTarget['workspace'] };
  }

  const linked = await db.query.workspaces.findMany({
    where: sqlWhere(and(inArray(workspaces.id, wsIds), isNotNull(workspaces.githubRepoId))),
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
    where: sqlWhere(eq(githubRepos.id, workspace.githubRepoId)),
    with: { installation: true },
  });
  if (!repo?.installation) return null;
  return { fullName: repo.fullName as string, installationId: repo.installation.installationId as number };
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
  // Or a person's workspace-wide review grant (prReach.scope): review only, never supersede.
  if (account.taskScope && !ownsViaWorker
    && !(await taskScopeTaskLinksPr(account, { workspaceId: account.taskScope.workspaceId, prNumber }))
    && !(await taskScopeHoldsWorkspaceReviewReach(account, { workspaceId: account.taskScope.workspaceId }))) {
    return bad('A task token may request review only of its own PR, or one its task\'s records link', 403);
  }

  // A PR the workflow kernel owns is reviewed only in kernel rounds; any other
  // PR is adopted and handed to a reviewer (lib/request-pr-review.ts, the one
  // request path this route and the PR webhook's auto-review share).
  const person = requestingPerson(null, account);
  const out = await requestPrReview({
    workspace, repo, pr, prNumber, existingWorker: existingWorker ?? null,
    requester: {
      person,
      actor: person ? `human:${person}` : `agent:${account.id}`,
      principal: kernelPrincipalOf({ person, account }),
      accountId: account.id,
      teamId: account.teamId,
      creationSource: 'mcp',
      surface: 'POST /api/github/pr/review',
      origin: 'api',
    },
    force: body.force === true,
    reviewerRole: typeof body.reviewerRole === 'string' ? body.reviewerRole : null,
    callbackUrl,
    callbackOn,
  });
  if (out.kind === 'response') return out.response as NextResponse;
  return NextResponse.json(out.body, { status: out.status });
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
    ? await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, owningWorker.taskId)), columns: { missionId: true } })
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

  // Living Spec fa62b865 R-50: a kernel-owned PR answers with the one review reading the task page,
  // get_pr and the sticky comment show: the same state line, rounds and open findings.
  const delivery = owningWorker?.taskId
    ? (await getDeliveryViewsForTasks([owningWorker.taskId]).catch(() => new Map())).get(owningWorker.taskId) ?? null
    : null;
  const r = delivery?.review ?? null;
  const reading = r ? {
    stateLine: r.stateLine, verdict: r.verdict, round: r.round, roundsSpent: r.roundsSpent, roundBudget: r.roundBudget, blocks: r.blocks,
    openFindings: r.openFindings.map((f: { text: string }) => f.text),
  } : null;

  return NextResponse.json({
    ok: true,
    prNumber,
    workspaceId: workspace.id,
    waitFor,
    autoMergeExpected,
    timedOut,
    status,
    reading,
  });
}
