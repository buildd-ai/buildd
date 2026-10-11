/**
 * POST /api/workers/[id]/pause
 *
 * Pause a running agent instead of stopping it (lib/worker-pause.ts). The
 * runner stops at its next safe point, keeps the worktree and session, and the
 * worker waits as `waiting_input` with `waitingFor.type = 'pause'`. Resume is
 * answering it, through /respond, which continues the same session.
 *
 * Auth: a signed-in member of the worker's workspace, or the API key that
 * claimed the worker. Refused for a worker that is not running (409), already
 * paused (409), or a local session buildd cannot reach (400).
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { authenticateApiKey } from '@/lib/api-auth';
import { callerOwnsWorker } from '@/lib/worker-owner';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { pauseRefusal, requestWorkerPause } from '@/lib/worker-pause';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // A non-simple request, so another origin cannot fire it from a plain form.
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey, req);
  if (!user && !account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({ where: eq(workers.id, id) });
  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }
  if (account) {
    if (!callerOwnsWorker(account, worker)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else if (user && !(await verifyWorkspaceAccess(user.id, worker.workspaceId))) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  const refusal = pauseRefusal(worker);
  if (refusal) {
    return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: refusal.status });
  }
  if (!(await requestWorkerPause(id))) {
    return NextResponse.json({ error: 'The agent stopped running before the pause landed.', code: 'not_running' }, { status: 409 });
  }
  return NextResponse.json({
    ok: true,
    requested: true,
    message: 'Pausing at the next safe point. The run keeps its session; Resume continues it.',
  });
}
