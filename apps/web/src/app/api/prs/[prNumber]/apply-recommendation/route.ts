/**
 * POST /api/prs/[prNumber]/apply-recommendation
 *
 * Human-triggered "Apply" / "Apply with corrections" action on an escalate-
 * verdict escalation card (see WaitingOnYouReviewCard). Dispatches a fix task
 * on the PR's own branch carrying the reviewer's recommendation — the same
 * shape as the automatic `request-changes` retry in
 * `handleReviewerOutcomeIfNeeded` (apps/web/src/app/api/workers/[id]/route.ts),
 * but human-initiated: fresh iteration budget, `creationSource: 'dashboard'`,
 * and (when `corrections` is supplied) the human's text as the authoritative
 * instruction with the recommendation demoted to context.
 *
 * Auth: session user who has access to the workspace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, missionNotes, workspaces } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveOpenWorkerForUser } from '@/lib/pr-resolve';
import { selectReviewerEvidence } from '@/lib/reviewer-evidence';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { applyRecommendationTitle } from '@/lib/task-title';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { supersedeAncestorEscalations } from '@/lib/escalation-supersession';

// A human choosing to apply a fix is a deliberate one-off, not another lap of
// the bounded agent-only request-changes loop — it gets its own fresh budget
// (see the "Apply dispatch" spec note) rather than continuing whatever the
// automatic loop's counter was at when it escalated. 3 matches the platform
// default `handleReviewerOutcomeIfNeeded` falls back to.
const APPLY_MAX_ITERATIONS = 3;

const STOP_AND_REPORT =
  'If this turns out to be a misdiagnosis rather than a real defect, stop and report why instead of patching around it.';

function buildApplyDescription(
  originalDescription: string | null,
  recommendation: string,
  corrections: string | null,
): string {
  const sections = corrections
    ? [
        '## Correction (authoritative instruction)',
        corrections,
        '',
        "## Reviewer's recommendation (context — the correction above takes precedence wherever it conflicts)",
        recommendation,
      ]
    : [
        "## Apply the reviewer's recommendation",
        recommendation,
      ];
  sections.push('', STOP_AND_REPORT, '', '## Original task', originalDescription ?? '');
  return sections.join('\n');
}

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
  let corrections: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.workspaceId === 'string') workspaceId = body.workspaceId;
    if (typeof body?.corrections === 'string' && body.corrections.trim().length > 0) {
      corrections = body.corrections.trim();
    }
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

  // The reviewer's recommendation, read the same way the escalation card
  // itself is built — never re-derived or re-summarised.
  const notes = await db.query.missionNotes.findMany({
    where: and(
      eq(missionNotes.taskId, originalTask.id),
      inArray(missionNotes.type, ['reviewer_escalated', 'reviewer_approved']),
    ),
    columns: { taskId: true, type: true, body: true, title: true, status: true, createdAt: true },
  });
  const { escalationMap } = selectReviewerEvidence(notes);
  const evidence = escalationMap.get(originalTask.id);
  if (!evidence?.recommendation) {
    return NextResponse.json(
      { error: 'No open reviewer recommendation to apply for this PR' },
      { status: 409 },
    );
  }

  const description = buildApplyDescription(originalTask.description, evidence.recommendation, corrections ?? null);

  // Dedup reuses the SAME (workspaceId, reviewerRetryPrNumber, reviewerRetryHeadSha)
  // partial unique index the automatic request-changes retry uses — escalate and
  // request-changes are mutually exclusive verdicts for one headSha review, so a
  // second Apply call for the same (PR, headSha) is a true double-tap, not a
  // legitimate second dispatch.
  const [applyTask] = await db
    .insert(tasks)
    .values({
      workspaceId: worker.workspaceId,
      title: applyRecommendationTitle(originalTask.title),
      description,
      missionId: originalTask.missionId,
      parentTaskId: originalTask.id,
      taskClass: 'attempt',
      reviewerRetryPrNumber: prNumber,
      reviewerRetryHeadSha: headSha,
      context: {
        iteration: 0,
        maxIterations: APPLY_MAX_ITERATIONS,
        baseBranch: worker.branch,
        resumeBranch: worker.branch,
        lastCommitSha: headSha,
        failureContext: {
          summary: corrections ?? evidence.recommendation,
          errorType: 'reviewer_escalation_applied',
          commitSha: headSha,
        },
        prNumber,
        prUrl: worker.prUrl,
        workerBranch: worker.branch,
        appliedBy: user.email,
        recommendation: evidence.recommendation,
        corrections: corrections ?? null,
      },
      pathManifest: originalTask.pathManifest,
      release: 'false',
      priority: 8,
      status: 'pending',
      creationSource: 'dashboard',
    })
    .onConflictDoNothing()
    .returning();

  if (!applyTask) {
    // Duplicate — another Apply call (or an automatic retry) already dispatched
    // a fix task for this exact (PR, headSha). Return the existing one instead
    // of erroring so a double-tap reads as success, not failure.
    const existing = await db.query.tasks.findFirst({
      where: and(
        eq(tasks.workspaceId, worker.workspaceId),
        eq(tasks.reviewerRetryPrNumber, prNumber),
        eq(tasks.reviewerRetryHeadSha, headSha),
      ),
      columns: { id: true },
    });
    return NextResponse.json({ ok: true, dispatched: false, taskId: existing?.id ?? null });
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, worker.workspaceId),
  });
  if (workspace) {
    await dispatchNewTask(applyTask, workspace);
  }

  // Close the loop: an open reviewer_escalated note is an unconditional
  // human-actor signal to resolveReviewerGate, ahead of any reviewer-task-state
  // inference — without this the card never leaves Waiting-on-You no matter
  // what the new task's own eventual review does.
  await supersedeAncestorEscalations(db, originalTask.id, prNumber);

  if (originalTask.missionId) {
    await db.insert(missionNotes).values({
      missionId: originalTask.missionId,
      taskId: originalTask.id,
      authorType: 'user',
      actorLabel: user.email,
      type: 'decision',
      title: `PR #${prNumber}: reviewer recommendation applied by ${user.email}`,
      body: corrections
        ? `Applied with corrections:\n\n${corrections}\n\nReviewer's original recommendation (context):\n\n${evidence.recommendation}`
        : `Applied verbatim:\n\n${evidence.recommendation}`,
      status: 'open',
    });
  }

  // Best-effort — a failed GitHub App lookup must not fail the dispatch itself.
  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, worker.workspaceId),
      columns: { id: true },
      with: { githubRepo: { columns: { fullName: true }, with: { installation: { columns: { installationId: true } } } } },
    });
    const installationId = ws?.githubRepo?.installation?.installationId;
    const repoFullName = ws?.githubRepo?.fullName;
    if (installationId && repoFullName) {
      await appendPrActivity({
        installationId,
        repoFullName,
        prNumber,
        entry: {
          kind: 'human_applied_recommendation',
          detail: corrections ? `Applied by ${user.email} with corrections` : `Applied by ${user.email}`,
        },
        workspaceId: worker.workspaceId,
      });
    }
  } catch (err) {
    console.warn(`[apply-recommendation] failed to append PR activity for PR #${prNumber}:`, err);
  }

  return NextResponse.json({ ok: true, dispatched: true, taskId: applyTask.id });
}
