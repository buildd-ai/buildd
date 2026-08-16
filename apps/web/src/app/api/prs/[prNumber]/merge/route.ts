/**
 * POST /api/prs/[prNumber]/merge
 *
 * Human-triggered merge for PRs in the escalation inbox (merge policy BT-15/17).
 * Finds the worker by prNumber, merges via GitHub App, stamps mergedAt, and
 * triggers downstream task unblocking.
 *
 * Auth: session user who has access to the workspace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import { eq, and, inArray, isNotNull, isNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { mergePullRequest, githubApi } from '@/lib/github';
import { checkAndUnblockDependentMissions } from '@/lib/mission-dependency';
import { checkDependsOnResolved } from '@/lib/task-dependencies';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { classifyMergeFailure, dispatchConflictRetry } from '@/lib/conflict-retry';

export async function POST(
  _req: NextRequest,
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

  // Get user's accessible workspace IDs
  const wsIds = await getUserWorkspaceIds(user.id);
  if (wsIds.length === 0) {
    return NextResponse.json({ error: 'No workspaces found' }, { status: 403 });
  }

  // Fetch ALL unmerged workers matching this prNumber across the user's workspaces.
  // PR numbers are not unique across repos — findFirst would silently pick the wrong
  // workspace's worker if two repos both happen to have an open PR with this number.
  const matchingWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, wsIds),
      eq(workers.prNumber, prNumber),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
    ),
    columns: {
      id: true,
      taskId: true,
      workspaceId: true,
      prUrl: true,
      prNumber: true,
      prLifecycleStatus: true,
      lastCommitSha: true,
    },
    with: {
      task: {
        columns: { id: true, missionId: true, status: true },
      },
    },
  });

  if (matchingWorkers.length === 0) {
    return NextResponse.json({ error: 'PR not found or already merged' }, { status: 404 });
  }

  // Guard against cross-workspace ambiguity: if the same PR number appears in
  // multiple repos, we cannot know which one to merge without a workspaceId.
  const distinctWorkspaceIds = new Set(matchingWorkers.map((w) => w.workspaceId));
  if (distinctWorkspaceIds.size > 1) {
    console.error(
      `[pr-merge] PR #${prNumber} matched ${distinctWorkspaceIds.size} workspaces — ambiguous merge rejected`,
    );
    return NextResponse.json(
      {
        error: `PR #${prNumber} exists in multiple workspaces — use the workspace-specific view to merge`,
      },
      { status: 422 },
    );
  }

  const worker = matchingWorkers[0];

  if (worker.prLifecycleStatus === 'closed') {
    return NextResponse.json({ error: 'PR is closed and cannot be merged' }, { status: 409 });
  }

  // Resolve repo and installation via githubRepos — the same path used by PR
  // creation and resolveReleaseTarget(). The legacy workspaces.repo and
  // workspaces.githubInstallationId columns can be stale or null, which causes
  // GitHub to return 404 "Not Found" on the merge PUT.
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, worker.workspaceId),
    columns: { id: true },
    with: {
      githubRepo: {
        columns: { fullName: true },
        with: {
          installation: {
            columns: { installationId: true },
          },
        },
      },
    },
  });

  if (!workspace?.githubRepo?.installation?.installationId) {
    return NextResponse.json({ error: 'Workspace has no GitHub installation' }, { status: 422 });
  }

  const installationId = workspace.githubRepo.installation.installationId;
  const repoFullName = workspace.githubRepo.fullName;

  console.log(
    `[pr-merge] merging PR #${prNumber} — worker=${worker.id} workspace=${worker.workspaceId} repo=${repoFullName} installation=${installationId}`,
  );

  // Perform the merge
  const result = await mergePullRequest(installationId, repoFullName, prNumber, 'squash');

  if (!result.merged) {
    const rawMessage = result.message ?? '';
    console.error(
      `[pr-merge] GitHub rejected merge of PR #${prNumber} on ${repoFullName}: ${rawMessage}`,
    );

    const failureClass = classifyMergeFailure(rawMessage);

    if (failureClass === 'conflict' && worker.taskId) {
      // Fetch the current head SHA for dedup key
      let headSha = worker.lastCommitSha ?? '';
      if (!headSha) {
        try {
          const prData = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
          headSha = prData?.head?.sha ?? '';
        } catch {
          headSha = '';
        }
      }

      if (headSha) {
        const dispatchResult = await dispatchConflictRetry({
          workerId: worker.id,
          taskId: worker.taskId,
          prNumber,
          headSha,
          repoFullName,
          workspaceId: worker.workspaceId,
        }).catch(err => {
          console.error(`[pr-merge] conflict-retry dispatch failed for PR #${prNumber}:`, err);
          return { dispatched: false } as import('@/lib/conflict-retry').DispatchConflictRetryResult;
        });

        if (dispatchResult.dispatched) {
          return NextResponse.json(
            {
              error: `PR #${prNumber} has merge conflicts. A conflict-resolution task has been dispatched automatically.`,
              conflictRetryDispatched: true,
              conflictRetryTaskId: dispatchResult.taskId,
            },
            { status: 409 },
          );
        }
        if (dispatchResult.exhausted) {
          return NextResponse.json(
            {
              error: `PR #${prNumber} has merge conflicts and conflict-resolution retries are exhausted. Manual action required: rebase onto the base branch, resolve conflicts, or abandon this PR.`,
              conflictExhausted: true,
            },
            { status: 409 },
          );
        }
        if (dispatchResult.disabled) {
          // Feature disabled — fall through to standard error
        } else {
          // Duplicate dedup hit — already handling it
          return NextResponse.json(
            {
              error: `PR #${prNumber} has merge conflicts. A conflict-resolution task is already in progress.`,
              conflictRetryDispatched: false,
            },
            { status: 409 },
          );
        }
      }
    }

    // Map GitHub's opaque errors to actionable copy; keep raw message in server log only.
    const userMessage = /not found/i.test(rawMessage)
      ? 'GitHub could not find the repo or the buildd App lacks access — verify the App is installed on this repo with contents: write permission'
      : failureClass === 'conflict'
      ? `GitHub rejected the merge: PR has merge conflicts. Use "Resolve conflicts" to dispatch an auto-fix, or manually rebase and push.`
      : /method not allowed|405/i.test(rawMessage)
      ? 'PR is not in a mergeable state — check CI status and branch protection rules'
      : `GitHub rejected the merge: ${rawMessage}`;
    return NextResponse.json({ error: userMessage }, { status: 422 });
  }

  // Stamp mergedAt and update lifecycle status
  await db
    .update(workers)
    .set({ mergedAt: new Date(), prLifecycleStatus: 'merged', updatedAt: new Date() })
    .where(eq(workers.id, worker.id));

  // Trigger real-time update
  await triggerEvent(channels.workspace(worker.workspaceId), events.WORKER_PROGRESS, {
    taskId: worker.taskId,
  });

  // Unblock tasks that depend on this task (mergedAt now set — gate is clear)
  if (worker.taskId) {
    checkDependsOnResolved(worker.taskId).catch((e: unknown) =>
      console.error(`[pr-merge] checkDependsOnResolved failed for task ${worker.taskId}:`, e)
    );
  }

  // Unblock dependent missions if this task belonged to one
  const missionId = (worker.task as any)?.missionId;
  if (missionId) {
    checkAndUnblockDependentMissions(missionId, 'merged').catch((e: unknown) =>
      console.error(`[pr-merge] unblock failed for mission ${missionId}:`, e)
    );
  }

  return NextResponse.json({ ok: true, merged: true });
}
