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
import { workers, tasks, workspaces, githubInstallations, missions } from '@buildd/core/db/schema';
import { eq, and, inArray, isNotNull, isNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { mergePullRequest } from '@/lib/github';
import { checkAndUnblockDependentMissions } from '@/lib/mission-dependency';
import { triggerEvent, channels, events } from '@/lib/pusher';

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

  // Find the open worker for this PR in one of the user's workspaces
  const worker = await db.query.workers.findFirst({
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
    },
    with: {
      task: {
        columns: { id: true, missionId: true, status: true },
      },
    },
  });

  if (!worker) {
    return NextResponse.json({ error: 'PR not found or already merged' }, { status: 404 });
  }

  // Load workspace to get the repo and installation
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, worker.workspaceId),
    columns: { id: true, repo: true, githubInstallationId: true },
    with: {
      githubInstallation: {
        columns: { installationId: true },
      },
    },
  });

  if (!workspace?.repo || !workspace.githubInstallation?.installationId) {
    return NextResponse.json({ error: 'Workspace has no GitHub installation' }, { status: 422 });
  }

  const installationId = workspace.githubInstallation.installationId;
  const repoFullName = workspace.repo;

  // Perform the merge
  const result = await mergePullRequest(installationId, repoFullName, prNumber, 'squash');

  if (!result.merged) {
    return NextResponse.json({ error: result.message }, { status: 422 });
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

  // Unblock dependent missions if this task belonged to one
  const missionId = (worker.task as any)?.missionId;
  if (missionId) {
    checkAndUnblockDependentMissions(missionId, 'merged').catch((e: unknown) =>
      console.error(`[pr-merge] unblock failed for mission ${missionId}:`, e)
    );
  }

  return NextResponse.json({ ok: true, merged: true });
}
