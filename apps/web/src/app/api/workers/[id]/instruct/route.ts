import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller, isOrchestrationTaskToken, taskScopeAllowsMissionTask } from '@/lib/task-token-auth';
import { holdsInWorkspace } from '@/lib/team-access';
import { pushInstructionDelivery } from '@/lib/worker-instruction-push';
import { isUnreachableWorkerStatus, queueInstruction } from '@/lib/worker-instructions';

// POST /api/workers/[id]/instruct - Send instructions to a worker (admin only)
//
// Delivery model. A queued instruction is handed to its consumer (the runner's
// sync, or an interactive session's receive_messages) at the next turn
// boundary and is cleared only when the consumer confirms it injected the text;
// the runner is woken with a text-free `deliver_pending` so that does not wait
// for its next activity-driven sync.
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
  // workers.id is a uuid column: a non-UUID can never name a worker, and
  // querying with one throws 22P02, which escaped as a 500.
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Check for admin access via session OR admin-level API token
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  // Must have session auth OR admin-level API token, or be an orchestration
  // task's admin per-task token, which may steer only the workers of tasks on
  // its own task's mission (checked below). hasTokenRouteAdminAccess is false
  // for any task token.
  const hasSessionAuth = !!user;
  const hasAdminToken = hasTokenRouteAdminAccess(apiAccount, req);
  const orchestrationToken = !!apiAccount && isOrchestrationTaskToken(apiAccount);

  if (!hasSessionAuth && !hasAdminToken && !orchestrationToken) {
    return NextResponse.json(
      { error: 'Unauthorized - requires session auth or admin-level API token' },
      { status: 401 }
    );
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: {
      workspace: { columns: { dataClass: true, teamId: true } },
      task: { columns: { id: true, workspaceId: true, missionId: true } },
    },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // The caller must be able to administer the worker's workspace: an
  // admin-level key belonging to the workspace's team, or a session user with
  // admin/owner role in it. Anything else sees "not found".
  const canAdminister = orchestrationToken
    ? !!worker.task && worker.workspaceId === apiAccount!.taskScope!.workspaceId
      && await taskScopeAllowsMissionTask(apiAccount!, worker.task)
    : hasAdminToken
      ? apiAccount!.teamId === worker.workspace?.teamId
      : await holdsInWorkspace(user!.id, worker.workspaceId, 'steer_workers');
  if (!canAdminister) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
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

  // One enqueue path for every sender (see queueInstruction): queued for any
  // consumer that can acknowledge, text over Pusher only where the queue
  // cannot carry it (a legacy runner, or an urgent message to a terminal
  // worker whose session the runner may still hold).
  const queued = queueInstruction(
    {
      instructionHistory: worker.instructionHistory,
      pendingInstructions: worker.pendingInstructions,
      turns: worker.turns,
      status: worker.status,
      runner: (worker as { runner?: string | null }).runner,
      supportsInstructionAck: (worker as { supportsInstructionAck?: boolean }).supportsInstructionAck,
    },
    { message, isSensitive, priority },
  );

  // Read-modify-write: two instructions sent in the same instant can still lose
  // one (pre-existing, and equally true of instructionHistory). A concurrent
  // hand-off cannot lose one, because the queue is cleared by a compare-and-set
  // on the delivered text, not blindly.
  await db
    .update(workers)
    .set({
      pendingInstructions: queued.pendingInstructions,
      instructionHistory: queued.instructionHistory,
      updatedAt: new Date(),
    })
    .where(eq(workers.id, id))
    .returning();

  await pushInstructionDelivery(id, queued);

  return NextResponse.json({
    ok: true,
    message: queued.queueable
      ? "Queued — delivered at the agent's next turn boundary; get_task_messages shows when it is read"
      : 'Instructions sent via Pusher — delivery is not confirmed',
    deliveryState: queued.deliveryState,
    messageId: queued.id,
    workerId: id,
  });
}
