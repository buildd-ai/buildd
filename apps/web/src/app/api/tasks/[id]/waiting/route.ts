import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { probeCoordination } from '@/lib/coordination-probe';
import { loadQueueWaits } from '@/lib/queue-wait-load';
import { blockingReasons, coordinationHoldBody, orderWaitingReasons, readForceStart, type WaitingKind } from '@buildd/core/waiting-reason';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { startAnywayView } from '@/lib/start-anyway';

/**
 * GET /api/tasks/[id]/waiting
 *
 * Why a pending task is not running, in the canonical `WaitingReason` shape:
 * the same probe `/start` refuses on, so the task sheet, the full page and the
 * mission drawer can say "Waiting on PR #1234 · both edit …" instead of
 * runner-liveness copy. Read-only. A non-pending task has no reasons.
 *
 * The probe's reasons are joined by the claim query's own prefilters and the
 * claim loop's limits it does not cover (lib/queue-wait-load.ts), so a task
 * the claim refuses for a start time, a hold, the workspace cap or a budget is
 * never shown as ready; `queueWait` is the one reason explain, the mission row
 * and both queues give (spec: Overlap scheduling, AC-10). None of the joined
 * reasons is forceable, so a Force start's digest is the probe's own.
 *
 * Body: { waitingReasons, queueWait?, reasonsDigest?, canForce?, force?, notForceable?,
 *         forceStart? (an unexpired intent awaiting its claim), probed }
 */

/** Kinds the start probe produces itself; the queue-wait read adds the rest. */
const PROBE_KINDS: ReadonlySet<WaitingKind> = new Set<WaitingKind>(['mission_local', 'dep_declared', 'lane', 'mission_concurrent', 'ordered_behind']);
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  let userId: string | null = null;
  // The authenticated account itself, not its id: a grant session is judged on the grant.
  let account: Awaited<ReturnType<typeof authenticateApiKey>> = null;
  if (apiKey) {
    account = await authenticateApiKey(apiKey, req);
    if (!account) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  } else {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    userId = user.id;
  }

  const { id: taskId } = await params;
  const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, taskId)) });
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  const allowed = userId
    ? await verifyWorkspaceAccess(userId, task.workspaceId)
    : await verifyAccountWorkspaceAccess(account!, task.workspaceId);
  if (!allowed) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const now = new Date();
  // The observed Start anyway phase (requested / assessing / blocked), from the
  // row's own facts: the one derivation every surface renders.
  const ctx = task.context as Record<string, unknown> | null;
  const blockerId = (ctx?.waitExit as { blockerTaskId?: string } | undefined)?.blockerTaskId;
  const blockerTitle = task.status === 'pending' && blockerId && ctx?.forceStartHistory
    ? (await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, blockerId)), columns: { title: true } }).catch(() => null))?.title ?? null
    : null;
  const view = startAnywayView({ context: ctx, status: task.status, now, prerequisiteTitle: blockerTitle });
  const startAnyway = view ? { startAnyway: view } : {};

  if (task.status !== 'pending') return NextResponse.json({ waitingReasons: [], probed: true, ...startAnyway });

  const [probed, live] = await Promise.all([
    probeCoordination(task as any, now),
    loadQueueWaits([task.id], now).then(m => m.get(task.id) ?? null),
  ]);
  const forceStart = readForceStart(task.context as Record<string, unknown> | null, now);
  if (probed === null) return NextResponse.json({ waitingReasons: [], ...(live ? { queueWait: live.wait } : {}), probed: false, ...startAnyway });
  const reasons = orderWaitingReasons([...probed, ...(live?.reasons ?? []).filter(r => !PROBE_KINDS.has(r.kind))]);
  const blocking = blockingReasons(reasons);
  return NextResponse.json({
    ...(blocking.length > 0 ? coordinationHoldBody(blocking) : {}),
    waitingReasons: reasons,
    ...(live ? { queueWait: live.wait } : {}),
    ...(forceStart ? { forceStart: { kinds: forceStart.kinds, expiresAt: forceStart.expiresAt } } : {}),
    ...startAnyway,
    probed: true,
  });
}
