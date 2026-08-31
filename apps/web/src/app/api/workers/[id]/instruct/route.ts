import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';
import {
  appendInstructionHistory,
  enqueuePendingInstruction,
  isUnreachableWorkerStatus,
} from '@/lib/worker-instructions';

// POST /api/workers/[id]/instruct - Send instructions to a worker (admin only)
//
// Delivery model. A queued instruction is handed to the runner on its next
// check-in and is cleared only when the runner confirms it injected the text.
// An urgent instruction additionally goes out over Pusher for instant delivery.
//
// This endpoint must only accept workers the check-in route will actually serve:
// `completed`, `failed` and `error` workers have their PATCH rejected with a 409
// long before the delivery code runs, so queueing for them is a promise that can
// never be kept.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Check for admin access via session OR admin-level API token
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  // Must have session auth OR admin-level API token
  const hasSessionAuth = !!user;
  const hasAdminToken = apiAccount?.level === 'admin';

  if (!hasSessionAuth && !hasAdminToken) {
    return NextResponse.json(
      { error: 'Unauthorized - requires session auth or admin-level API token' },
      { status: 401 }
    );
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { workspace: { columns: { dataClass: true } } },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Verify workspace access if using session auth (not admin token)
  if (hasSessionAuth && !hasAdminToken) {
    const access = await verifyWorkspaceAccess(user!.id, worker.workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
  }

  // Can't instruct completed/failed workers
  if (worker.status === 'completed' || worker.status === 'failed') {
    return NextResponse.json(
      { error: 'Cannot instruct completed or failed workers' },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { message, priority } = body;

  if (!message || typeof message !== 'string') {
    return NextResponse.json(
      { error: 'Message is required' },
      { status: 400 }
    );
  }

  const isUrgent = priority === 'urgent';

  // An `error` worker is rejected by the check-in route (409, `abort: true`), so
  // it never collects a queued instruction. Saying "queued for delivery on next
  // worker check-in" here was a promise nothing could keep. The Pusher path can
  // still reach a session the runner holds in memory (sendMessage restarts it),
  // so urgent is allowed through — but nothing is queued for it either.
  if (isUnreachableWorkerStatus(worker.status) && !isUrgent) {
    return NextResponse.json(
      {
        error: `Cannot queue instructions for a worker in state '${worker.status}' — ` +
          'its next check-in is rejected, so the instruction would never be delivered',
        workerStatus: worker.status,
        hint: "Retry with priority:'urgent' to attempt an immediate Pusher delivery to a " +
          'resident session, or POST /api/workers/<id>/recover to restart the worker.',
      },
      { status: 409 }
    );
  }

  const isSensitive = (worker.workspace as any)?.dataClass === 'sensitive';

  // Only a runner that speaks the delivery-confirmation protocol can confirm a
  // delivery (and can be trusted not to double-inject a message that arrived
  // both over Pusher and over the queue). Older runners get exactly the old
  // behaviour: Pusher only, optimistically recorded as delivered.
  const ackCapable = (worker as { supportsInstructionAck?: boolean }).supportsInstructionAck === true;

  // Terminal-but-urgent: Pusher only — a queued copy could never be collected.
  const queueable = !isUnreachableWorkerStatus(worker.status) && (!isUrgent || ackCapable);
  // 'delivered' is only written where no confirmation can ever arrive.
  const deliveryState = queueable || ackCapable ? 'pending' : 'delivered';

  const updatedHistory = appendInstructionHistory(worker.instructionHistory, {
    message,
    isSensitive,
    deliveryState,
  });

  // Urgent instructions are queued as well as pushed, so a Pusher event that
  // reaches nobody (runner offline, not yet subscribed, Pusher down) is still
  // recoverable on the next check-in. The runner de-duplicates: it skips
  // injecting text it already injected and acknowledges it instead.
  //
  // Read-modify-write: two instructions sent in the same instant can still lose
  // one (pre-existing, and equally true of instructionHistory). A concurrent
  // hand-off cannot lose one, because the queue is cleared by a compare-and-set
  // on the delivered text, not blindly.
  await db
    .update(workers)
    .set({
      pendingInstructions: queueable
        ? enqueuePendingInstruction(worker.pendingInstructions, message)
        : worker.pendingInstructions ?? null,
      instructionHistory: updatedHistory,
      updatedAt: new Date(),
    })
    .where(eq(workers.id, id))
    .returning();

  if (isUrgent) {
    await triggerEvent(
      channels.worker(id),
      events.WORKER_COMMAND,
      { action: 'message', text: message, timestamp: Date.now() }
    );
  }

  return NextResponse.json({
    ok: true,
    message: isUrgent
      ? queueable
        ? 'Instructions sent via Pusher and queued as a fallback — delivery is reported once the agent receives them'
        : 'Instructions sent via Pusher — delivery is not confirmed'
      : 'Instructions queued for delivery on next worker check-in',
    deliveryState,
    workerId: id,
  });
}
