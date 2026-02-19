import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, artifacts, tasks } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { ArtifactType } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';

// POST /api/workers/[id]/plan/approve - Approve the plan and continue to execution
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

  // Parse optional mode from request body
  let mode: 'bypass' | 'review' = 'review';
  try {
    const body = await req.json();
    if (body.mode === 'bypass' || body.mode === 'review') {
      mode = body.mode;
    }
  } catch {
    // No body or invalid JSON — use default
  }

  // Verify worker is in the correct state
  if (worker.status !== 'awaiting_plan_approval') {
    return NextResponse.json({
      error: 'Worker is not awaiting plan approval',
      currentStatus: worker.status,
    }, { status: 400 });
  }

  // Get the plan artifact
  const plan = await db.query.artifacts.findFirst({
    where: and(
      eq(artifacts.workerId, id),
      eq(artifacts.type, ArtifactType.TASK_PLAN)
    ),
  });

  if (!plan) {
    return NextResponse.json({ error: 'No plan found to approve' }, { status: 404 });
  }

  // Update plan metadata to mark as approved
  await db
    .update(artifacts)
    .set({
      metadata: {
        ...((plan.metadata as Record<string, unknown>) || {}),
        approvedAt: new Date().toISOString(),
        approvedBy: account.id,
      },
    })
    .where(eq(artifacts.id, plan.id));

  // Update task mode to execution (for the worker to continue in execution mode)
  if (worker.taskId) {
    await db
      .update(tasks)
      .set({
        mode: 'execution',
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, worker.taskId));
  }

  // Update worker status to running and set pending instructions
  const modeLabel = mode === 'bypass' ? 'bypass permissions' : 'with review';
  const approvalMessage = `Approve & implement (${modeLabel === 'bypass permissions' ? 'bypass permissions' : 'with review'})`;

  const [updatedWorker] = await db
    .update(workers)
    .set({
      status: 'running',
      currentAction: 'Plan approved - starting implementation',
      pendingInstructions: approvalMessage,
      updatedAt: new Date(),
    })
    .where(eq(workers.id, id))
    .returning();

  // Trigger realtime events
  await triggerEvent(
    channels.worker(id),
    'worker:plan_approved',
    { worker: updatedWorker }
  );

  // Send command to worker to resume (via Pusher)
  await triggerEvent(
    channels.worker(id),
    'worker:command',
    {
      action: 'message',
      text: approvalMessage,
      timestamp: Date.now(),
    }
  );

  if (worker.workspaceId) {
    await triggerEvent(
      channels.workspace(worker.workspaceId),
      'worker:plan_approved',
      { worker: updatedWorker }
    );
  }

  return NextResponse.json({
    message: 'Plan approved - worker will continue with implementation',
    worker: updatedWorker,
  });
}
