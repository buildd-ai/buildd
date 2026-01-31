import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, workers, tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';

async function authenticateApiKey(apiKey: string | null) {
  if (!apiKey) return null;
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.apiKey, apiKey),
  });
  return account || null;
}

// GET /api/workers/[id] - Get worker details
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { task: true, workspace: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json(worker);
}

// PATCH /api/workers/[id] - Update worker status
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const { status, progress, error, costUsd, turns, localUiUrl, currentAction, milestones } = body;

  const updates: Partial<typeof workers.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (status) updates.status = status;
  if (typeof progress === 'number') updates.progress = progress;
  if (error !== undefined) updates.error = error;
  if (typeof costUsd === 'number') updates.costUsd = costUsd.toString();
  if (typeof turns === 'number') updates.turns = turns;
  if (localUiUrl !== undefined) updates.localUiUrl = localUiUrl;
  if (currentAction !== undefined) updates.currentAction = currentAction;
  if (milestones !== undefined) updates.milestones = milestones;

  // Handle status transitions
  if (status === 'running' && !worker.startedAt) {
    updates.startedAt = new Date();
  }
  if (status === 'completed' || status === 'failed') {
    updates.completedAt = new Date();

    // Update task status
    if (worker.taskId) {
      await db
        .update(tasks)
        .set({
          status: status === 'completed' ? 'completed' : 'failed',
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, worker.taskId));
    }
  }

  const [updated] = await db
    .update(workers)
    .set(updates)
    .where(eq(workers.id, id))
    .returning();

  // Trigger realtime events
  const eventName = status === 'completed' ? events.WORKER_COMPLETED
    : status === 'failed' ? events.WORKER_FAILED
    : events.WORKER_PROGRESS;

  await triggerEvent(
    channels.worker(id),
    eventName,
    { worker: updated }
  );

  if (worker.workspaceId) {
    await triggerEvent(
      channels.workspace(worker.workspaceId),
      eventName,
      { worker: updated }
    );
  }

  return NextResponse.json(updated);
}
