/**
 * POST /api/prs/[prNumber]/retry-ci
 *
 * Human-triggered "Fix CI" action on a red PR — the manual counterpart to the
 * automatic `check_suite` webhook retry in `handleCheckSuiteFailure`
 * (apps/web/src/app/api/github/webhook/route.ts). Same plumbing: adopt the PR
 * if buildd has no worker for it (`resolveOrAdoptPrOwner`), classify the
 * failure, and dispatch — a drift-class failure always gets a diagnose-only
 * task (see `ci-drift-diagnose.ts`), never a fix agent. There is no override:
 * this action offers the same diagnose-only path for a drift failure that the
 * webhook does.
 *
 * Unlike the automatic path, a deliberate human click is never declined for
 * exhausted or disabled retries — same reasoning as `apply-recommendation`'s
 * fresh budget: the automatic loop's counter does not bind a one-off human
 * decision.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces, githubRepos } from '@buildd/core/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { githubApi } from '@/lib/github';
import { resolveOrAdoptPrOwner } from '@/lib/pr-review-request';
import { checkPrIsDraft, fetchCIFailureLogs, fetchCommitAuthor, isBuilddWorkerCommit } from '@/lib/ci-failure-inspect';
import { isSchemaDriftFailure, buildDriftDiagnoseTask } from '@/lib/ci-drift-diagnose';
import { buildCIRetryTask, DEFAULT_MAX_CI_RETRIES } from '@/lib/ci-retry';
import { LIVE_TASK_STATUSES } from '@/lib/task-presentation';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { appendPrActivity } from '@/lib/pr-activity-comment';

function bad(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ prNumber: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return bad('Unauthorized', 401);

  const { prNumber: prNumberStr } = await params;
  const prNumber = parseInt(prNumberStr, 10);
  if (!prNumber || isNaN(prNumber)) return bad('Invalid PR number', 400);

  const body = await req.json().catch(() => ({}));
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : null;
  if (!workspaceId) return bad('workspaceId is required', 400);

  const accessible = await getUserWorkspaceIds(user.id);
  if (!accessible.includes(workspaceId)) {
    return bad('Workspace not found or not accessible', 403);
  }

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!workspace) return bad('Workspace not found', 404);
  if (!workspace.githubRepoId || !workspace.githubInstallationId) {
    return bad('Workspace is not linked to a GitHub repo', 400);
  }

  const repo = await db.query.githubRepos.findFirst({
    where: eq(githubRepos.id, workspace.githubRepoId),
    with: { installation: true },
  });
  if (!repo?.installation) return bad('Workspace is not linked to a GitHub repo', 400);
  const installationId = repo.installation.installationId as number;
  const repoFullName = repo.fullName as string;

  // Idempotency: a red PR already being fixed (automatically or by a prior
  // manual click) returns that task instead of stacking a second one. Scoped
  // to context.prNumber, same field the CI-retry and drift-diagnose tasks
  // both carry, and the same field Home's ciAttemptMap reads.
  const inFlight = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.taskClass, 'attempt'),
      inArray(tasks.status, [...LIVE_TASK_STATUSES]),
      sql`(${tasks.context}->>'prNumber')::int = ${prNumber}`,
    ),
    columns: { id: true, outputRequirement: true },
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  if (inFlight) {
    return NextResponse.json({
      ok: true,
      dispatched: false,
      inFlight: true,
      taskId: inFlight.id,
      diagnoseOnly: inFlight.outputRequirement === 'artifact_required',
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pr: any;
  try {
    pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return bad(`Could not read PR #${prNumber} on ${repoFullName}: ${message}`, message.includes('404') ? 404 : 502);
  }
  if (!pr?.number) return bad(`PR #${prNumber} not found on ${repoFullName}`, 404);
  if (pr.state !== 'open') {
    return bad(`PR #${prNumber} is ${pr.merged ? 'merged' : pr.state} — only an open PR can be fixed`, 409);
  }

  const headRepoFullName = pr.head?.repo?.full_name as string | undefined;
  if (headRepoFullName && headRepoFullName.toLowerCase() !== repoFullName.toLowerCase()) {
    return bad('Cannot dispatch a CI fix for a fork PR', 400);
  }

  const isDraft = await checkPrIsDraft(installationId, repoFullName, prNumber);
  if (isDraft) return bad(`PR #${prNumber} is a draft — not ready for CI feedback`, 409);

  const { ownerWorker, originalTask } = await resolveOrAdoptPrOwner({
    workspaceId,
    installationId,
    repoFullName,
    prNumber,
    pr,
    creationSource: 'dashboard',
  });

  const headSha = pr.head?.sha as string;
  const [ciLogs, commitAuthor] = await Promise.all([
    fetchCIFailureLogs(installationId, repoFullName, headSha),
    fetchCommitAuthor(installationId, repoFullName, headSha),
  ]);
  const failureContext = ciLogs.summary ||
    `CI failing on ${repoFullName} PR #${prNumber} (SHA: ${headSha})`;

  // Schema drift is diagnose-only — no override exists in this action either.
  if (isSchemaDriftFailure(ciLogs.failedJobNames)) {
    const diagnoseTask = buildDriftDiagnoseTask({
      originalTask: {
        id: originalTask.id,
        title: originalTask.title,
        workspaceId,
        missionId: originalTask.missionId,
      },
      repoFullName,
      prNumber,
      headSha,
      failureContext,
      ciRunUrl: ciLogs.runUrl,
    });

    const [newDiagnoseTask] = await db
      .insert(tasks)
      .values({
        workspaceId: diagnoseTask.workspaceId,
        title: diagnoseTask.title,
        description: diagnoseTask.description,
        parentTaskId: diagnoseTask.parentTaskId,
        ciRetryPrNumber: prNumber,
        ciRetryHeadSha: headSha,
        missionId: diagnoseTask.missionId,
        context: diagnoseTask.context,
        creationSource: 'dashboard',
        taskClass: diagnoseTask.taskClass,
        outputRequirement: diagnoseTask.outputRequirement,
        status: 'pending',
        priority: 8,
      })
      .returning();

    if (newDiagnoseTask) {
      await dispatchNewTask(newDiagnoseTask, workspace);
      await appendPrActivity({
        installationId,
        repoFullName,
        prNumber,
        entry: { kind: 'ci_fixing', detail: `schema drift detected — dispatched diagnose-only task by ${user.email}, no auto-fix`, url: ciLogs.runUrl },
        workspaceId,
      });
    }

    return NextResponse.json({
      ok: true,
      dispatched: true,
      diagnoseOnly: true,
      taskId: newDiagnoseTask?.id ?? null,
    });
  }

  const isWorkerCommit = isBuilddWorkerCommit(commitAuthor);
  const foreignHeadSha = !isWorkerCommit;

  // A deliberate human click is never a dead end — fresh iteration budget,
  // same reasoning as apply-recommendation's APPLY_MAX_ITERATIONS. This
  // ignores the workspace's maxCiRetries/exhaustion counter on purpose: that
  // counter bounds the AUTOMATIC loop, not a one-off human decision.
  const retryTask = buildCIRetryTask({
    originalTask: {
      id: originalTask.id,
      title: originalTask.title,
      description: originalTask.description,
      workspaceId,
      context: { iteration: 0 },
      missionId: originalTask.missionId,
    },
    worker: { id: ownerWorker.id, branch: ownerWorker.branch, prNumber },
    failureContext,
    repoFullName,
    ciRunId: ciLogs.runId,
    ciFailedJobId: ciLogs.failedJobId,
    ciRunUrl: ciLogs.runUrl,
    workspaceMaxCiRetries: DEFAULT_MAX_CI_RETRIES,
    foreignHeadSha,
    foreignCommitAuthor: foreignHeadSha
      ? (commitAuthor.login ?? commitAuthor.name ?? commitAuthor.email ?? 'unknown')
      : undefined,
  });

  if (!retryTask) {
    // Unreachable in practice — a fresh iteration:0 budget never exhausts —
    // but buildCIRetryTask's contract allows null, so handle it rather than
    // asserting.
    return bad('Could not build a CI retry task', 500);
  }

  const [newTask] = await db
    .insert(tasks)
    .values({
      workspaceId: retryTask.workspaceId,
      title: retryTask.title,
      description: retryTask.description,
      parentTaskId: retryTask.parentTaskId,
      ciRetryPrNumber: prNumber,
      ciRetryHeadSha: headSha,
      missionId: retryTask.missionId,
      context: retryTask.context,
      creationSource: 'dashboard',
      taskClass: retryTask.taskClass,
      status: 'pending',
      priority: 8,
    })
    .returning();

  if (newTask) {
    await dispatchNewTask(newTask, workspace);
    await appendPrActivity({
      installationId,
      repoFullName,
      prNumber,
      entry: { kind: 'ci_fixing', detail: `manual fix dispatched by ${user.email}`, url: ciLogs.runUrl },
      workspaceId,
    });
  }

  return NextResponse.json({
    ok: true,
    dispatched: !!newTask,
    diagnoseOnly: false,
    taskId: newTask?.id ?? null,
  });
}
