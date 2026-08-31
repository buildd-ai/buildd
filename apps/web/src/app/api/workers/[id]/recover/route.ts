import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { isNonReactivatableError } from '@/lib/worker-termination';

/**
 * POST /api/workers/[id]/recover
 *
 * Trigger recovery for a stale/failed worker. Sends a 'recover' command
 * to the runner via Pusher. The runner then spawns a doctor agent to
 * diagnose, complete, or restart the worker.
 *
 * Body: { mode: 'diagnose' | 'complete' | 'restart' }
 *
 * Env: BUILDD_RECOVER_GUARD_TERMINATED=true also refuses recovery for workers
 * the SERVER terminated (expiry / heartbeat loss / runner restart / reassign /
 * human takeover) — the same set the PATCH handler refuses to reactivate.
 * Defaults to off, i.e. today's behaviour: the command is sent and the status is
 * flipped even though no runner is listening.
 */
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

  // Verify access
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
  const { mode } = body;

  const validModes = ['diagnose', 'complete', 'restart'];
  if (!mode || !validModes.includes(mode)) {
    return NextResponse.json(
      { error: `Invalid mode. Must be one of: ${validModes.join(', ')}` },
      { status: 400 }
    );
  }

  // A cleanly completed worker has nothing to recover, and flipping it back to
  // `running` destroys the completion: nothing re-syncs a locally-finished
  // worker, so the row sits at `running` with a frozen updatedAt until the
  // reaper kills a task that had actually succeeded. Same failure the PATCH
  // route's reactivation guard exists to prevent.
  if (worker.status === 'completed') {
    return NextResponse.json(
      { error: 'Worker already completed — nothing to recover', actualStatus: worker.status },
      { status: 409 },
    );
  }

  // Server-owned terminations (expired / went offline / runner restarted /
  // reassigned / interrupted) mean the runner that would answer this command is
  // gone. Gated: refusing is a contract change for callers that fire recover at
  // any dead worker today.
  if (process.env.BUILDD_RECOVER_GUARD_TERMINATED === 'true' && isNonReactivatableError(worker.error)) {
    return NextResponse.json(
      {
        error: 'Worker was terminated by the server — recover has no effect',
        reason: worker.error,
        actualStatus: worker.status,
      },
      { status: 409 },
    );
  }

  // Update worker status to indicate recovery is in progress. CAS on the status
  // we read: recovery raced against a real completion (or another recover) and,
  // updating by id alone, won by luck and overwrote whichever landed first.
  const [recovered] = await db
    .update(workers)
    .set({
      status: 'running',
      error: null,
      updatedAt: new Date(),
    })
    .where(and(eq(workers.id, id), eq(workers.status, worker.status)))
    .returning();

  if (!recovered) {
    return NextResponse.json(
      { error: 'Worker state changed concurrently — recover has no effect' },
      { status: 409 },
    );
  }

  // Send recover command via Pusher
  await triggerEvent(
    channels.worker(id),
    events.WORKER_COMMAND,
    {
      action: 'recover',
      recoveryMode: mode,
      timestamp: Date.now(),
    }
  );

  return NextResponse.json({ ok: true, mode, workerId: id });
}
