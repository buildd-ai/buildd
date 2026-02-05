import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, artifacts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { ArtifactType } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';

// POST /api/workers/[id]/plan - Submit a plan for review
export async function POST(
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
    with: { task: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const { plan } = body;

  if (!plan || typeof plan !== 'string') {
    return NextResponse.json({ error: 'Plan content required' }, { status: 400 });
  }

  // Create or update the plan artifact
  const existingPlan = await db.query.artifacts.findFirst({
    where: and(
      eq(artifacts.workerId, id),
      eq(artifacts.type, ArtifactType.TASK_PLAN)
    ),
  });

  let artifact;
  if (existingPlan) {
    // Update existing plan
    [artifact] = await db
      .update(artifacts)
      .set({
        content: plan,
        metadata: { submittedAt: new Date().toISOString() },
      })
      .where(eq(artifacts.id, existingPlan.id))
      .returning();
  } else {
    // Create new plan artifact
    [artifact] = await db
      .insert(artifacts)
      .values({
        workerId: id,
        type: ArtifactType.TASK_PLAN,
        title: `Implementation Plan: ${worker.task?.title || 'Task'}`,
        content: plan,
        metadata: { submittedAt: new Date().toISOString() },
      })
      .returning();
  }

  // Update worker status to awaiting plan approval
  const [updatedWorker] = await db
    .update(workers)
    .set({
      status: 'awaiting_plan_approval',
      currentAction: 'Plan submitted - awaiting approval',
      updatedAt: new Date(),
    })
    .where(eq(workers.id, id))
    .returning();

  // Trigger realtime events
  await triggerEvent(
    channels.worker(id),
    events.WORKER_PROGRESS,
    { worker: updatedWorker, artifact }
  );

  if (worker.workspaceId) {
    await triggerEvent(
      channels.workspace(worker.workspaceId),
      'worker:plan_submitted',
      { worker: updatedWorker, artifact }
    );
  }

  return NextResponse.json({
    message: 'Plan submitted successfully',
    artifact,
    worker: updatedWorker,
  });
}

// GET /api/workers/[id]/plan - Get the current plan
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
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Get the plan artifact
  const plan = await db.query.artifacts.findFirst({
    where: and(
      eq(artifacts.workerId, id),
      eq(artifacts.type, ArtifactType.TASK_PLAN)
    ),
  });

  if (!plan) {
    return NextResponse.json({ error: 'No plan found' }, { status: 404 });
  }

  return NextResponse.json({ plan });
}
