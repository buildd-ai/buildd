import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { appendInstructionHistory } from '@/lib/worker-instructions';

// POST /api/workers/[id]/cmd - Send command to worker via Pusher
//
// `action: 'message'` is human input to the agent, so it is recorded in
// `workers.instructionHistory` exactly like /instruct does. It used to fire the
// Pusher event and persist nothing, which left the task UI's message list and
// `get_task_messages` under-reporting every message sent through this route.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dual auth: session OR API key
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

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

  // Verify access: API key checks account ownership, session checks workspace membership
  if (account) {
    if (worker.accountId !== account.id) {
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

  // Record human input before pushing it, so a Pusher failure still leaves a
  // trace of what was sent. deliveryState stays 'pending' until the runner
  // confirms the text reached the agent session (PATCH `instructionsDelivered`);
  // runners that predate that protocol never confirm, so their messages are
  // recorded as delivered here — the same assumption the old /instruct made.
  let deliveryState: 'pending' | 'delivered' | undefined;
  if (action === 'message' && typeof text === 'string' && text.length > 0) {
    const isSensitive = (worker.workspace as { dataClass?: string } | null)?.dataClass === 'sensitive';
    deliveryState = (worker as { supportsInstructionAck?: boolean }).supportsInstructionAck === true
      ? 'pending'
      : 'delivered';
    await db
      .update(workers)
      .set({
        instructionHistory: appendInstructionHistory(worker.instructionHistory, {
          message: text,
          isSensitive,
          deliveryState,
        }),
        updatedAt: new Date(),
      })
      .where(eq(workers.id, id));
  }

  // Push command via Pusher
  await triggerEvent(
    channels.worker(id),
    events.WORKER_COMMAND,
    { action, text, timestamp: Date.now() }
  );

  return NextResponse.json({ ok: true, action, ...(deliveryState ? { deliveryState } : {}) });
}
