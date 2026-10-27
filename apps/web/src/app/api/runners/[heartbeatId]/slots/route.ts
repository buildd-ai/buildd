import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { parseRunnerSlots, MIN_RUNNER_SLOTS, MAX_RUNNER_SLOTS } from '@buildd/shared';
import { isUuid } from '@/lib/uuid';
import { authorizeRunnerControl, nudgeRunner } from '@/lib/runner-control-access';

/**
 * PATCH /api/runners/[heartbeatId]/slots  { slots }
 *
 * A team owner or admin sets one runner's slots from buildd.dev (spec 34a48877
 * R-5, R-20..R-23). Saved as the runner's desired value with who and when; the
 * runner's next heartbeat reply carries it and a nudge makes that beat happen
 * now. A runner that is offline gets it when it next checks in. The reported
 * value (what the runner runs at) is not touched here: it changes when the
 * runner reports it. 0 is allowed: the runner claims nothing (spec 97b1bd0b
 * R-18); Pause is the separate state (../pause).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ heartbeatId: string }> },
) {
  const { heartbeatId } = await params;
  if (!isUuid(heartbeatId)) {
    return NextResponse.json({ error: `Invalid runner id: expected a UUID, got "${heartbeatId}".` }, { status: 404 });
  }
  const access = await authorizeRunnerControl(heartbeatId, 'Only a team owner or admin can change a runner\'s slots.');
  if (!access.ok) return access.response;
  const { target } = access;

  const body = await req.json().catch(() => null) as { slots?: unknown } | null;
  const slots = parseRunnerSlots(body?.slots);
  if (slots === null) {
    return NextResponse.json({ error: `slots must be a whole number from ${MIN_RUNNER_SLOTS} to ${MAX_RUNNER_SLOTS}` }, { status: 400 });
  }

  const setAt = new Date();
  await db.update(workerHeartbeats)
    .set({ desiredSlots: slots, desiredSlotsOrigin: 'dashboard', desiredSlotsSetBy: target.setBy, desiredSlotsSetAt: setAt })
    .where(eq(workerHeartbeats.id, heartbeatId));
  await nudgeRunner(target, setAt);

  return NextResponse.json({ ok: true, desiredSlots: { slots, origin: 'dashboard', setBy: target.setBy, setAt: setAt.toISOString() } });
}
