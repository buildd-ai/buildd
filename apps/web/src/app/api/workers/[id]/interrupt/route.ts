/**
 * POST /api/workers/[id]/interrupt
 *
 * Human takeover: terminate a live reviewer worker and promote the PR to the
 * human merge queue. Only reviewer workers (task.category = 'review') may be
 * interrupted this way.
 *
 * Auth: session user — must have workspace access.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks, missionNotes } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, taskId: true, workspaceId: true, status: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  const wsIds = await getUserWorkspaceIds(user.id);
  if (!wsIds.includes(worker.workspaceId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!worker.taskId) {
    return NextResponse.json({ error: 'Worker has no task' }, { status: 400 });
  }

  const reviewerTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, worker.taskId),
    columns: { id: true, category: true, context: true },
  });

  if (reviewerTask?.category !== 'review') {
    return NextResponse.json({ error: 'Worker is not a reviewer — only reviewer workers can be interrupted' }, { status: 400 });
  }

  if (!LIVE_WORKER_STATUSES.includes(worker.status as any)) {
    return NextResponse.json({ error: 'Worker is already terminal — interrupt has no effect' }, { status: 409 });
  }

  const ctx = (reviewerTask.context ?? {}) as Record<string, unknown>;
  const originalTaskId = ctx.reviewerFor as string | undefined;
  const prNumber = ctx.prNumber as number | undefined;

  // Terminate the reviewer worker
  await db
    .update(workers)
    .set({
      status: 'failed',
      error: 'Interrupted — human takeover',
      exitCause: 'infra_failure',
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workers.id, id));

  // Fail the reviewer task so it doesn't get re-claimed
  await db
    .update(tasks)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(eq(tasks.id, worker.taskId));

  // Post a reviewer_escalated note on the original task so the PR surfaces in
  // the human queue with a clear reason ("Agent review interrupted").
  if (originalTaskId) {
    const originalTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, originalTaskId),
      columns: { missionId: true },
    });

    if (originalTask?.missionId) {
      await db.insert(missionNotes).values({
        missionId: originalTask.missionId,
        taskId: originalTaskId,
        authorType: 'user',
        type: 'reviewer_escalated',
        title: `PR #${prNumber ?? '?'} — agent review interrupted, human takeover`,
        body: 'Agent review was interrupted. Review and merge this PR manually.',
        status: 'open',
      });
    }
  }

  // Broadcast so the workspace dashboard refreshes
  await triggerEvent(
    channels.workspace(worker.workspaceId),
    events.WORKER_FAILED,
    { workerId: id, taskId: worker.taskId, status: 'failed' },
  );

  return NextResponse.json({ ok: true });
}
