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
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { authenticateApiKey } from '@/lib/api-auth';
import { getTeamWorkspaceIds } from '@/lib/team-access';
import { resolveWorkspace } from '@/lib/workspace-resolver';
import { resolvePolicy } from '@/lib/merge-policy';
import { createReviewerTask } from '@/lib/reviewer';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import {
  findPrOwningWorker,
  findReviewTaskForPr,
  listWorkspaceRoles,
  waitForPrReviewStatus,
} from '@/lib/pr-review-request';
import {
  derivePrReviewStatus,
  pickReviewerRole,
  MAX_REVIEW_WAIT_SECONDS,
  type PrReviewWaitFor,
} from '@/lib/pr-review-status';

type Account = { id: string; teamId: string };

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
  account: Account,
  prNumber: number,
  workspaceIdInput: string | null,
): Promise<ResolvedTarget | { error: string; status: number; candidates?: string[] }> {
  if (workspaceIdInput) {
    const ws = await resolveWorkspace(workspaceIdInput);
    if (!ws) return { error: `Workspace '${workspaceIdInput}' not found`, status: 404 };
    if (ws.teamId !== account.teamId) {
      return { error: 'Workspace belongs to a different team', status: 403 };
    }
    return { workspace: ws as ResolvedTarget['workspace'] };
  }

  const wsIds = await getTeamWorkspaceIds(account.teamId);
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
  const account = await authenticateApiKey(req.headers.get('authorization')?.replace('Bearer ', '') || null);
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
    account as Account,
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
  const existingReview = await findReviewTaskForPr(workspace.id, prNumber);
  const inFlight = existingReview?.status === 'pending' || existingReview?.status === 'in_progress';
  const force = body.force === true;

  // Idempotency: one reviewer per PR at a time. `force` re-reviews a finished
  // review but never stacks a second agent onto a running one — two reviewers
  // on one PR race each other's verdicts.
  if (existingReview && (inFlight || !force)) {
    const policy = await resolveEffectivePolicy(workspace, null);
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

  // Adopt the PR when buildd has no worker for it: every downstream surface
  // keys off "the worker that owns this PR", so adoption is what lets an
  // externally-authored PR use the existing review rails unchanged.
  let ownerWorker = existingWorker;
  let adopted = false;
  let originalTask: {
    id: string;
    title: string;
    description: string | null;
    backend: 'claude' | 'codex';
    missionId: string | null;
    pathManifest?: string[] | null;
    iteration?: number | null;
    maxIterations?: number | null;
  };

  if (ownerWorker?.taskId) {
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, ownerWorker.id),
      with: { task: true },
    });
    const task = (worker as any)?.task;
    originalTask = {
      id: task?.id ?? ownerWorker.taskId,
      title: task?.title ?? pr.title ?? `PR #${prNumber}`,
      description: task?.description ?? null,
      backend: task?.backend ?? 'claude',
      missionId: task?.missionId ?? null,
      pathManifest: task?.pathManifest ?? null,
      iteration: typeof task?.context?.iteration === 'number' ? task.context.iteration : 0,
      maxIterations: typeof task?.context?.maxIterations === 'number' ? task.context.maxIterations : 3,
    };
  } else {
    const [adoptedTask] = await db
      .insert(tasks)
      .values({
        workspaceId: workspace.id,
        title: `PR #${prNumber}: ${pr.title ?? 'untitled'}`,
        description: typeof pr.body === 'string' ? pr.body.slice(0, 8000) : null,
        // The work is already done — the PR exists. A pending task here would
        // be claimable by a runner and re-do it.
        status: 'completed',
        priority: 5,
        release: 'false',
        creationSource: 'mcp',
        context: {
          adoptedPr: {
            prNumber,
            prUrl: pr.html_url,
            headSha: pr.head?.sha ?? null,
            baseBranch: pr.base?.ref ?? null,
            author: pr.user?.login ?? null,
            adoptedAt: new Date().toISOString(),
          },
        },
      })
      .returning({ id: tasks.id });

    if (!adoptedTask?.id) return bad('Could not adopt the PR (task insert failed)', 500);

    const [adoptedWorker] = await db
      .insert(workers)
      .values({
        workspaceId: workspace.id,
        taskId: adoptedTask.id,
        accountId: account.id,
        name: `pr-${prNumber}-review`,
        // Not a runner buildd operates — the commits came from elsewhere.
        runner: 'external',
        branch: pr.head?.ref ?? `pr-${prNumber}`,
        status: 'completed',
        prNumber,
        prUrl: pr.html_url,
        prLifecycleStatus: 'pr_open',
        ...(typeof pr.base?.sha === 'string' ? { prOpenedBaseSha: pr.base.sha } : {}),
        ...(typeof pr.additions === 'number' ? { linesAdded: pr.additions } : {}),
        ...(typeof pr.deletions === 'number' ? { linesRemoved: pr.deletions } : {}),
        ...(typeof pr.changed_files === 'number' ? { filesChanged: pr.changed_files } : {}),
      })
      .returning({ id: workers.id });

    adopted = true;
    ownerWorker = {
      id: adoptedWorker?.id ?? 'adopted',
      taskId: adoptedTask.id,
      branch: pr.head?.ref ?? `pr-${prNumber}`,
      prUrl: pr.html_url,
      prLifecycleStatus: 'pr_open',
      mergedAt: null,
    } as typeof ownerWorker;
    originalTask = {
      id: adoptedTask.id,
      title: pr.title ?? `PR #${prNumber}`,
      description: typeof pr.body === 'string' ? pr.body.slice(0, 8000) : null,
      backend: 'claude',
      missionId: null,
      pathManifest: null,
      iteration: 0,
      maxIterations: 3,
    };
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
    installationId: repo.installationId,
    repoFullName: repo.fullName,
    policyConfig: (workspace.gitConfig as any)?.policyConfig,
    ...(callbackUrl ? { reviewCallback: { url: callbackUrl, on: callbackOn } } : {}),
  });

  if (!reviewerTask?.id) return bad('Could not create the reviewer task', 500);

  await dispatchNewTask(
    {
      id: reviewerTask.id,
      title: `Review PR #${prNumber}: ${originalTask.title}`,
      description: null,
      workspaceId: workspace.id,
      missionId: originalTask.missionId,
    },
    workspace as never,
  );

  // Say so on the PR itself, exactly as the webhook path does.
  await appendPrActivity({
    installationId: repo.installationId,
    repoFullName: repo.fullName,
    prNumber,
    entry: { kind: 'reviewing', detail: `reviewer role \`${picked.role}\`` },
    workspaceId: workspace.id,
  });

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

export async function GET(req: NextRequest) {
  const account = await authenticateApiKey(req.headers.get('authorization')?.replace('Bearer ', '') || null);
  if (!account) return bad('Invalid API key', 401);

  const url = new URL(req.url);
  const prNumber = Number(url.searchParams.get('prNumber'));
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return bad('prNumber is required and must be a positive integer', 400);
  }

  const target = await resolveTarget(account as Account, prNumber, url.searchParams.get('workspaceId'));
  if ('error' in target) return bad(target.error, target.status, target.candidates ? { candidates: target.candidates } : {});
  const { workspace } = target;

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
