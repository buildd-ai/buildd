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
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { listWorkspaceRoles } from '@/lib/pr-review-request';
import { pickReviewerRole } from '@/lib/pr-review-status';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { supersedeAncestorEscalations } from '@/lib/escalation-supersession';
import { carryForwardApprovalIfUnchanged } from '@/lib/approval-carry-forward';
import { resolveReReviewPlan } from '@/lib/pr-re-review';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { requestReview as requestKernelReview } from '@/lib/workflow/seam';
import { workspaceRepo } from '@/lib/workflow/github-facts';

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

  // A PR the workflow kernel owns: the request is T5 (ReviewRequested) on the
  // live head, never on the runner-reported lastCommitSha. A person asking from
  // the dashboard may force a re-review of a head that already has a verdict.
  const kernelRepo = await workspaceRepo(worker.workspaceId).catch(() => null);
  if (kernelRepo) {
    const kernel = await requestKernelReview({
      workspaceId: worker.workspaceId, repoFullName: kernelRepo.repoFullName, prNumber,
      installationId: kernelRepo.installationId, forced: true, actor: `human:${user.id}`,
    }).catch((err) => {
      console.error(`[re-review] workflow kernel review request failed for PR #${prNumber}:`, err);
      return null;
    });
    if (kernel?.handled) {
      const r = kernel.result;
      if (r.result === 'applied') {
        await supersedeAncestorEscalations(db, originalTask.id, prNumber);
        return NextResponse.json({ ok: true, dispatched: true, kernel: true });
      }
      if (r.result === 'rejected' && r.reason === 'review_in_flight') {
        return NextResponse.json({ ok: true, alreadyRequested: true, kernel: true });
      }
      return NextResponse.json(
        { error: `Review not requested: ${r.reason}`, code: r.reason, current: r.current, kernel: true },
        { status: 409 },
      );
    }
  }

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

  // Delta re-review is the mechanism: a terminal verdict at a different SHA
  // gets a reviewer sent only the delta plus its own prior verdict, instead
  // of re-reading the whole PR from zero. `in_flight` means a reviewer is
  // already working this PR — the existing one-reviewer-per-PR guard, not a
  // second dispatch.
  const plan = await resolveReReviewPlan({
    workspaceId: worker.workspaceId,
    prNumber,
    currentHeadSha: headSha,
  });
  if (plan.kind === 'in_flight') {
    fireGateEvent({
      gate: GATE_SLUGS.REVIEWER_SINGLE_FLIGHT,
      surface: 'POST /api/prs/[prNumber]/re-review',
      outcome: 'deferred',
      reason: 'a reviewer is already working this PR',
      workspaceId: worker.workspaceId,
      missionId: originalTask.missionId,
      taskId: originalTask.id,
      workerId: worker.id,
      callerOrigin: 'dashboard',
      detail: { prNumber, reviewTaskId: plan.reviewTaskId },
    });
    return NextResponse.json({ ok: true, alreadyRequested: true, reviewTaskId: plan.reviewTaskId });
  }

  // A delta against an approval whose PR diff has not changed (rebase / base
  // merge only) has nothing to review: carry the approval to this head.
  const baseRef = (resolved as { prBaseRef?: string | null }).prBaseRef;
  if (plan.kind === 'delta' && plan.priorVerdict.verdict === 'approve' && baseRef) {
    const carry = await carryForwardApprovalIfUnchanged({
      installationId,
      repoFullName,
      workspaceId: worker.workspaceId,
      prNumber,
      baseRef,
      headSha,
    }).catch(() => ({ carried: false, reason: 'carry-forward check failed' }));
    if (carry.carried) {
      return NextResponse.json({ ok: true, carriedForward: true, reason: carry.reason });
    }
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
    confidenceThreshold: policy.agentReview?.maxConfidenceThreshold,
    installationId,
    repoFullName,
    policyConfig: (workspace as any).gitConfig?.policyConfig,
    baseRef: baseRef ?? null,
    ...(plan.kind === 'delta' ? { priorVerdict: plan.priorVerdict } : {}),
  });

  if (!reviewerTask?.id) {
    return NextResponse.json({ error: 'Could not create the reviewer task' }, { status: 500 });
  }

  if (!reviewerTask.deduplicated) {
    await announceTaskCreated(
      {
        id: reviewerTask.id,
        title: `Review PR #${prNumber}: ${originalTask.title}`,
        description: null,
        workspaceId: worker.workspaceId,
        missionId: originalTask.missionId,
        backend: originalTask.backend ?? 'claude',
        roleSlug: picked.role,
      },
      workspace as never,
    );
    await wakeTask(reviewerTask.id, 'task.created');

    await appendPrActivity({
      installationId,
      repoFullName,
      prNumber,
      entry: {
        kind: 'review_queued',
        detail: plan.kind === 'delta'
          ? `manual · since \`${plan.priorVerdict.headSha.slice(0, 7)}\``
          : 'manual',
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
