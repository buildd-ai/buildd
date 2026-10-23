import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { parseRunnerSlots, MIN_RUNNER_SLOTS, MAX_RUNNER_SLOTS } from '@buildd/shared';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamRole } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { channels, events, triggerEvent } from '@/lib/pusher';
import { forgetRunnerBeatState, runnerBeatId } from '@/lib/runner-beats';

/**
 * PATCH /api/runners/[heartbeatId]/slots  { slots }
 *
 * A team owner or admin sets one runner's slots from buildd.dev (spec 34a48877
 * R-5, R-20..R-23). Saved as the runner's desired value with who and when; the
 * runner's next heartbeat reply carries it and a nudge makes that beat happen
 * now. A runner that is offline gets it when it next checks in. The reported
 * value (what the runner runs at) is not touched here: it changes when the
 * runner reports it.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ heartbeatId: string }> },
) {
  const { heartbeatId } = await params;
  if (!isUuid(heartbeatId)) {
    return NextResponse.json({ error: `Invalid runner id: expected a UUID, got "${heartbeatId}".` }, { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const hb = await db.query.workerHeartbeats.findFirst({
    where: sqlWhere(eq(workerHeartbeats.id, heartbeatId)),
    columns: { id: true, accountId: true, localUiUrl: true },
    with: { account: { columns: { teamId: true } } },
  });
  const teamId = (hb as { account?: { teamId?: string | null } | null } | undefined)?.account?.teamId ?? null;
  // A runner of another team is not found, not forbidden: its existence is not for this caller.
  const role = hb && teamId ? await getUserTeamRole(user.id, teamId) : null;
  if (!hb || !role) return NextResponse.json({ error: 'Runner not found' }, { status: 404 });
  if (role !== 'owner' && role !== 'admin') {
    return NextResponse.json({ error: 'Only a team owner or admin can change a runner\'s slots.' }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as { slots?: unknown } | null;
  const slots = parseRunnerSlots(body?.slots);
  if (slots === null) {
    return NextResponse.json({ error: `slots must be a whole number from ${MIN_RUNNER_SLOTS} to ${MAX_RUNNER_SLOTS}` }, { status: 400 });
  }

  const setBy = user.name?.trim() || user.email?.split('@')[0] || 'a team admin';
  const setAt = new Date();
  await db.update(workerHeartbeats)
    .set({ desiredSlots: slots, desiredSlotsOrigin: 'dashboard', desiredSlotsSetBy: setBy, desiredSlotsSetAt: setAt })
    .where(eq(workerHeartbeats.id, heartbeatId));

  // The runner's next beat must read the row, then it is told.
  await forgetRunnerBeatState(runnerBeatId(hb.accountId, hb.localUiUrl));
  await triggerEvent(channels.runner(hb.accountId), events.RUNNER_SLOTS, { at: setAt.toISOString() });

  return NextResponse.json({ ok: true, desiredSlots: { slots, origin: 'dashboard', setBy, setAt: setAt.toISOString() } });
}
