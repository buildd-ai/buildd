import { NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamRole } from '@/lib/team-access';
import { roleHas } from '@/lib/permissions';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { channels, events, triggerEvent } from '@/lib/pusher';
import { forgetRunnerBeatState, runnerBeatId } from '@/lib/runner-beats';

export interface RunnerControlTarget {
  heartbeatId: string;
  accountId: string;
  localUiUrl: string;
  /** Who made the change, as the runner and the dashboard print it. */
  setBy: string;
}

/**
 * Who may change one runner's controls (slots, Pause) from buildd.dev: a team
 * owner or admin of the runner's team (spec 34a48877 R-23). A runner of
 * another team is not found, not forbidden: its existence is not for this
 * caller. The route checks the id is a UUID first (uuid-guard.test.ts).
 * Returns the runner, or the response to send.
 */
export async function authorizeRunnerControl(
  heartbeatId: string,
  forbidden: string,
): Promise<{ ok: true; target: RunnerControlTarget } | { ok: false; response: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

  const hb = await db.query.workerHeartbeats.findFirst({
    where: sqlWhere(eq(workerHeartbeats.id, heartbeatId)),
    columns: { id: true, accountId: true, localUiUrl: true },
    with: { account: { columns: { teamId: true } } },
  });
  const teamId = (hb as { account?: { teamId?: string | null } | null } | undefined)?.account?.teamId ?? null;
  const role = hb && teamId ? await getUserTeamRole(user.id, teamId) : null;
  if (!hb || !role) return { ok: false, response: NextResponse.json({ error: 'Runner not found' }, { status: 404 }) };
  if (!roleHas(role, 'manage_runner_slots')) {
    return { ok: false, response: NextResponse.json({ error: forbidden }, { status: 403 }) };
  }
  const setBy = user.name?.trim() || user.email?.split('@')[0] || 'a team admin';
  return { ok: true, target: { heartbeatId, accountId: hb.accountId, localUiUrl: hb.localUiUrl, setBy } };
}

/**
 * After a saved change: the runner's next beat must read the row, then it is
 * told to beat now. An offline runner gets the change when it next checks in.
 */
export async function nudgeRunner(target: RunnerControlTarget, at: Date): Promise<void> {
  await forgetRunnerBeatState(runnerBeatId(target.accountId, target.localUiUrl));
  await triggerEvent(channels.runner(target.accountId), events.RUNNER_SLOTS, { at: at.toISOString() });
}
