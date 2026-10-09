import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { authenticateApiKey } from '@/lib/api-auth';
import { callerOwnsWorker } from '@/lib/worker-owner';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { queueInstruction } from '@/lib/worker-instructions';
import { pushInstructionDelivery } from '@/lib/worker-instruction-push';

// POST /api/workers/[id]/cmd - Send command to worker via Pusher
//
// `action: 'message'` is human input to the agent, so it is queued and recorded
// in `workers.instructionHistory` exactly like /instruct does (queueInstruction).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // workers.id is a uuid column: a non-UUID can never name a worker, and
  // querying with one throws 22P02, which escaped as a 500.
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Dual auth: session OR API key
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey, req);

  if (!user && !account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { workspace: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Verify access: a bearer caller must be the principal that claimed the worker
  // (lib/worker-owner.ts); the dashboard session path checks workspace membership
  if (account) {
    if (!callerOwnsWorker(account, worker)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else if (user) {
    const access = await verifyWorkspaceAccess(user.id, worker.workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
  }

  const body = await req.json();
  const { action, text } = body;

  // Valid actions: pause, resume, abort, message
  const validActions = ['pause', 'resume', 'abort', 'message', 'recover'];
  if (!validActions.includes(action)) {
    return NextResponse.json(
      { error: `Invalid action. Must be one of: ${validActions.join(', ')}` },
      { status: 400 }
    );
  }

  // Human input goes through the same queue as /instruct, at urgent priority
  // (this route always delivered immediately). Recorded and queued before
  // anything is pushed, so a missed Pusher event is recovered from the queue on
  // the next check-in instead of being lost while history said pending forever.
  // The text itself rides Pusher only to a runner that cannot acknowledge.
  if (action === 'message') {
    if (typeof text !== 'string' || text.length === 0) {
      return NextResponse.json({ ok: true, action });
    }
    const isSensitive = (worker.workspace as { dataClass?: string } | null)?.dataClass === 'sensitive';
    const queued = queueInstruction(
      {
        instructionHistory: worker.instructionHistory,
        pendingInstructions: worker.pendingInstructions ?? null,
        turns: worker.turns,
        status: worker.status,
        runner: (worker as { runner?: string | null }).runner,
        supportsInstructionAck: (worker as { supportsInstructionAck?: boolean }).supportsInstructionAck,
      },
      { message: text, isSensitive, priority: 'urgent' },
    );
    await db
      .update(workers)
      .set({
        instructionHistory: queued.instructionHistory,
        pendingInstructions: queued.pendingInstructions,
        updatedAt: new Date(),
      })
      .where(eq(workers.id, id));
    await pushInstructionDelivery(id, queued);
    return NextResponse.json({ ok: true, action, deliveryState: queued.deliveryState, messageId: queued.id });
  }

  // Push command via Pusher
  await triggerEvent(
    channels.worker(id),
    events.WORKER_COMMAND,
    { action, text, timestamp: Date.now() }
  );

  return NextResponse.json({ ok: true, action });
}
