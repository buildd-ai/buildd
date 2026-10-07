import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { probeCoordination } from '@/lib/coordination-probe';
import { blockingReasons, coordinationHoldBody, readForceStart } from '@buildd/core/waiting-reason';

/**
 * GET /api/tasks/[id]/waiting
 *
 * Why a pending task is not running, in the canonical `WaitingReason` shape:
 * the same probe `/start` refuses on, so the task sheet, the full page and the
 * mission drawer can say "Waiting on PR #3818 · both edit …" instead of
 * runner-liveness copy. Read-only. A non-pending task has no reasons.
 *
 * Body: { waitingReasons, reasonsDigest?, canForce?, force?, notForceable?,
 *         forceStart? (an unexpired intent awaiting its claim), probed }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  let userId: string | null = null;
  let accountId: string | null = null;
  if (apiKey) {
    const account = await authenticateApiKey(apiKey, req);
    if (!account) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    accountId = account.id;
  } else {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    userId = user.id;
  }

  const { id: taskId } = await params;
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  const allowed = userId
    ? await verifyWorkspaceAccess(userId, task.workspaceId)
    : await verifyAccountWorkspaceAccess(accountId!, task.workspaceId);
  if (!allowed) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  if (task.status !== 'pending') return NextResponse.json({ waitingReasons: [], probed: true });

  const now = new Date();
  const reasons = await probeCoordination(task as any, now);
  const forceStart = readForceStart(task.context as Record<string, unknown> | null, now);
  if (reasons === null) return NextResponse.json({ waitingReasons: [], probed: false });
  const blocking = blockingReasons(reasons);
  return NextResponse.json({
    ...(blocking.length > 0 ? coordinationHoldBody(blocking) : {}),
    waitingReasons: reasons,
    ...(forceStart ? { forceStart: { kinds: forceStart.kinds, expiresAt: forceStart.expiresAt } } : {}),
    probed: true,
  });
}
