import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, artifacts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { triggerEvent, channels } from '@/lib/pusher';
import { ArtifactType } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';

// POST /api/workers/[id]/plan/revise - Request revisions to the plan
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dual auth: API key or session
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  const user = !account ? await getCurrentUser() : null;

  if (!account && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Verify worker is in the correct state
  if (worker.status !== 'awaiting_plan_approval') {
    return NextResponse.json({
      error: 'Worker is not awaiting plan approval',
      currentStatus: worker.status,
    }, { status: 400 });
  }

  const body = await req.json();
  const { feedback } = body;

  if (!feedback || typeof feedback !== 'string') {
    return NextResponse.json({ error: 'Feedback is required' }, { status: 400 });
  }

  // Get the plan artifact
  const plan = await db.query.artifacts.findFirst({
    where: and(
      eq(artifacts.workerId, id),
      eq(artifacts.type, ArtifactType.TASK_PLAN)
    ),
  });

  if (!plan) {
    return NextResponse.json({ error: 'No plan found to revise' }, { status: 404 });
  }

  // Track revision history in metadata
  const metadata = (plan.metadata as Record<string, unknown>) || {};
  const revisions = (metadata.revisions as Array<{ feedback: string; timestamp: string }>) || [];
  revisions.push({
    feedback,
    timestamp: new Date().toISOString(),
  });

  await db
    .update(artifacts)
    .set({
      metadata: {
        ...metadata,
        revisions,
        lastRevisionRequest: new Date().toISOString(),
      },
    })
    .where(eq(artifacts.id, plan.id));

  // Send revision request to worker
  const revisionMessage = `
The task author has requested revisions to your plan.

## Feedback
${feedback}

Please review the feedback above and submit an updated plan using the \`mcp__buildd__submit_plan\` tool.
Address the concerns raised in the feedback and improve your implementation approach.
`;

  // Update worker status back to running for re-planning
  const [updatedWorker] = await db
    .update(workers)
    .set({
      status: 'running',
      currentAction: 'Revising plan based on feedback',
      pendingInstructions: revisionMessage,
      updatedAt: new Date(),
    })
    .where(eq(workers.id, id))
    .returning();

  // Trigger realtime events - send message to worker
  await triggerEvent(
    channels.worker(id),
    'worker:command',
    {
      action: 'message',
      text: revisionMessage,
      timestamp: Date.now(),
    }
  );

  await triggerEvent(
    channels.worker(id),
    'worker:plan_revision_requested',
    { worker: updatedWorker, feedback }
  );

  if (worker.workspaceId) {
    await triggerEvent(
      channels.workspace(worker.workspaceId),
      'worker:plan_revision_requested',
      { worker: updatedWorker, feedback }
    );
  }

  return NextResponse.json({
    message: 'Revision request sent to worker',
    worker: updatedWorker,
  });
}
