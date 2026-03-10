import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

/**
 * POST /api/workers/[id]/recover
 *
 * Trigger recovery for a stale/failed worker. Sends a 'recover' command
 * to the runner via Pusher. The runner then spawns a doctor agent to
 * diagnose, complete, or restart the worker.
 *
 * Body: { mode: 'diagnose' | 'complete' | 'restart' }
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

  // Update worker status to indicate recovery is in progress
  await db
    .update(workers)
    .set({
      status: 'running',
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(workers.id, id));

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
