/**
 * POST /api/prs/[prNumber]/re-review
 *
 * Human-triggered forced re-dispatch of a reviewer agent, for a PR whose
 * review ended without a usable verdict — the reviewer task failed or was
 * cancelled, or none was ever dispatched. Nothing retries that on its own
 * (see WaitingOnYouReviewCard): this is the action that restores the normal
 * agent-review gate.
 *
 * Reuses the exact reviewer-dispatch machinery `POST /api/github/pr/review`
 * (the MCP `request_pr_review` action) uses, under session auth instead of an
 * API key — this button only ever targets a PR buildd already owns, so there
 * is no PR-adoption path to reproduce here.
 *
 * Auth: session user who has access to the workspace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveOpenWorkerForUser } from '@/lib/pr-resolve';
import { resolvePolicy } from '@/lib/merge-policy';
import { createReviewerTask } from '@/lib/reviewer';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { listWorkspaceRoles } from '@/lib/pr-review-request';
import { pickReviewerRole } from '@/lib/pr-review-status';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { supersedeAncestorEscalations } from '@/lib/escalation-supersession';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ prNumber: string }> }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { prNumber: prNumberStr } = await params;
  const prNumber = parseInt(prNumberStr, 10);
  if (!prNumber || isNaN(prNumber)) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  let workspaceId: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.workspaceId === 'string') workspaceId = body.workspaceId;
  } catch { /* non-fatal — body is optional */ }

  const resolved = await resolveOpenWorkerForUser(user.id, prNumber, workspaceId);
  if (typeof resolved.status === 'number') {
    return NextResponse.json(
      { error: resolved.error, candidates: resolved.candidates },
      { status: resolved.status },
    );
  }
  const worker = resolved as {
    id: string;
    taskId: string | null;
    workspaceId: string;
    branch: string;
    prUrl: string | null;
    lastCommitSha: string | null;
    task: {
      id: string;
      title: string;
      description: string | null;
      backend: 'claude' | 'codex' | null;
      missionId: string | null;
      pathManifest: string[] | null;
    } | null;
  };

  if (!worker.taskId || !worker.task) {
    return NextResponse.json({ error: 'No task found for this PR' }, { status: 404 });
  }
  const originalTask = worker.task;

  const headSha = worker.lastCommitSha;
  if (!headSha) {
    return NextResponse.json({ error: 'PR has no recorded head commit yet' }, { status: 422 });
  }
  if (!worker.prUrl) {
    return NextResponse.json({ error: 'PR has no recorded URL yet' }, { status: 422 });
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, worker.workspaceId),
    with: { githubRepo: { with: { installation: true } } },
  });
  const installationId = (workspace as any)?.githubRepo?.installation?.installationId;
  const repoFullName = (workspace as any)?.githubRepo?.fullName;
  if (!workspace || !installationId || !repoFullName) {
    return NextResponse.json({ error: 'Workspace has no GitHub installation' }, { status: 422 });
  }

  const mission = originalTask.missionId
    ? await db.query.missions.findFirst({
        where: eq(missions.id, originalTask.missionId),
        columns: { mergePolicy: true, requiresReview: true, workingBranch: true, integrationBranchEnabled: true },
      })
    : null;
  const policy = resolvePolicy(workspace as never, mission);

  const roles = await listWorkspaceRoles(worker.workspaceId, (workspace as any).teamId);
  const picked = pickReviewerRole({
    requested: null,
    policyRole: policy.agentReview?.reviewerRole ?? null,
    available: roles,
  });
  if (!picked.role) {
    return NextResponse.json({ error: picked.error ?? 'No reviewer role available' }, { status: 400 });
  }

  const reviewerTask = await createReviewerTask({
    workspaceId: worker.workspaceId,
    originalTaskId: originalTask.id,
    originalTask: {
      title: originalTask.title,
      description: originalTask.description,
      backend: originalTask.backend ?? 'claude',
      missionId: originalTask.missionId,
      pathManifest: originalTask.pathManifest,
      iteration: 0,
      maxIterations: 3,
    },
    worker: { branch: worker.branch },
    prNumber,
    prUrl: worker.prUrl,
    headSha,
    reviewerRole: picked.role,
    installationId,
    repoFullName,
    policyConfig: (workspace as any).gitConfig?.policyConfig,
  });

  if (!reviewerTask?.id) {
    return NextResponse.json({ error: 'Could not create the reviewer task' }, { status: 500 });
  }

  if (!reviewerTask.deduplicated) {
    await dispatchNewTask(
      {
        id: reviewerTask.id,
        title: `Review PR #${prNumber}: ${originalTask.title}`,
        description: null,
        workspaceId: worker.workspaceId,
        missionId: originalTask.missionId,
      },
      workspace as never,
    );

    await appendPrActivity({
      installationId,
      repoFullName,
      prNumber,
      entry: {
        kind: 'reviewing',
        detail: `reviewer role \`${picked.role}\` — re-review requested by ${user.email}`,
      },
      workspaceId: worker.workspaceId,
    });
  }

  // A prior terminal escalation (exhausted retries, or an explicit escalate
  // verdict) must not keep pinning the gate to the human while this fresh
  // review is live — otherwise the card would show the new review's queued
  // state alongside a stale "needs human" reason forever.
  await supersedeAncestorEscalations(db, originalTask.id, prNumber);

  return NextResponse.json({
    ok: true,
    dispatched: !reviewerTask.deduplicated,
    reviewTaskId: reviewerTask.id,
  });
}
