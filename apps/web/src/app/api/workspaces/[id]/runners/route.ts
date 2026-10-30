import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { freeSlots, runnerOnlineNow, RUNNER_STALE_CUTOFF_MS } from '@buildd/shared';
import { runnerLiveCandidateCutoff, withLiveRunnerBeats } from '@/lib/runner-beats';
import { isOpenWithinTeams } from '@/lib/open-workspaces';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/**
 * GET /api/workspaces/[id]/runners
 *
 * Returns runner instances registered for this workspace via heartbeats,
 * including account type, status, last heartbeat, and localUiUrl.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    // Open access reaches only runners of the owning team (the claim rule).
    const workspace = await db.query.workspaces.findFirst({
      where: sqlWhere(eq(workspaces.id, id)),
      columns: { teamId: true, accessMode: true },
    });

    const now = Date.now();
    // Listed up to the stale cutoff, which is wider than any "online now" window
    // (a presence-connected runner's last content beat can be many minutes old).
    const cutoff = runnerLiveCandidateCutoff(now, RUNNER_STALE_CUTOFF_MS);
    const rows = await db.query.workerHeartbeats.findMany({
      where: sqlWhere(gt(workerHeartbeats.lastHeartbeatAt, cutoff)),
      with: {
        account: {
          columns: { id: true, name: true, type: true, teamId: true },
        },
      },
    });
    const heartbeats = await withLiveRunnerBeats(rows);

    // Filter to heartbeats that have access to this workspace
    const runners = await Promise.all(
      heartbeats.map(async (hb) => {
        // Check if account is linked to this specific workspace
        const linked = await db.query.accountWorkspaces.findFirst({
          where: sqlWhere(and(
            eq(accountWorkspaces.accountId, hb.accountId),
            eq(accountWorkspaces.workspaceId, id),
          )),
          columns: { workspaceId: true },
        });
        const runnerTeamId = (hb.account as { teamId?: string | null } | null)?.teamId;
        const hasAccess = !!linked || (!!runnerTeamId && isOpenWithinTeams(workspace, [runnerTeamId]));

        if (!hasAccess) return null;

        const isOnline = runnerOnlineNow(hb.lastHeartbeatAt, hb.presenceConnected, now);

        return {
          id: hb.id,
          accountId: hb.accountId,
          accountName: hb.account?.name || 'Unknown',
          accountType: hb.account?.type || 'user',
          localUiUrl: hb.localUiUrl,
          status: isOnline ? 'online' : 'stale',
          lastHeartbeatAt: hb.lastHeartbeatAt,
          maxConcurrentWorkers: hb.maxConcurrentWorkers,
          activeWorkerCount: hb.activeWorkerCount,
          capacity: freeSlots(hb.maxConcurrentWorkers, hb.activeWorkerCount),
          environment: hb.environment,
        };
      })
    );

    const validRunners = runners.filter((r): r is NonNullable<typeof r> => r !== null);
    validRunners.sort((a, b) => {
      // Online first, then by capacity
      if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
      return b.capacity - a.capacity;
    });

    return NextResponse.json({ runners: validRunners });
  } catch (error) {
    console.error('Get runners error:', error);
    return NextResponse.json({ error: 'Failed to get runners' }, { status: 500 });
  }
}
