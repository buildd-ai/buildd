import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authorizeRunnerControl, nudgeRunner } from '@/lib/runner-control-access';

/**
 * PATCH /api/runners/[heartbeatId]/pause  { paused }
 *
 * A team owner or admin pauses or resumes one runner from buildd.dev (spec
 * 97b1bd0b R-18). Paused: take no new work, let running work finish. On the
 * runner it is `buildd hold` (runner-hold.ts), a state of its own: the slots
 * are not touched, so Resume brings back the ones it had. Saved with who and
 * when and delivered exactly as a slot change is (the heartbeat reply, a
 * nudge for now, on reconnect when offline); the later change wins against
 * `buildd hold` / `buildd resume` on the machine.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ heartbeatId: string }> },
) {
  const { heartbeatId } = await params;
  const access = await authorizeRunnerControl(heartbeatId, 'Only a team owner or admin can pause a runner.');
  if (!access.ok) return access.response;
  const { target } = access;

  const body = await req.json().catch(() => null) as { paused?: unknown } | null;
  if (typeof body?.paused !== 'boolean') {
    return NextResponse.json({ error: 'paused must be true or false' }, { status: 400 });
  }
  const paused = body.paused;

  const setAt = new Date();
  await db.update(workerHeartbeats)
    .set({ desiredPaused: paused, desiredPauseOrigin: 'dashboard', desiredPauseSetBy: target.setBy, desiredPauseSetAt: setAt })
    .where(eq(workerHeartbeats.id, heartbeatId));
  await nudgeRunner(target, setAt);

  return NextResponse.json({ ok: true, desiredPause: { paused, origin: 'dashboard', setBy: target.setBy, setAt: setAt.toISOString() } });
}
