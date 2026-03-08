import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { eq, gt, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

const HEARTBEAT_STALE_MS = 10 * 60 * 1000; // 10 minutes

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
    // Check if workspace is open access
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
      columns: { accessMode: true },
    });

    const cutoff = new Date(Date.now() - HEARTBEAT_STALE_MS);
    const heartbeats = await db.query.workerHeartbeats.findMany({
      where: gt(workerHeartbeats.lastHeartbeatAt, cutoff),
      with: {
        account: {
          columns: { id: true, name: true, type: true },
        },
      },
    });

    // Filter to heartbeats that have access to this workspace
    const runners = await Promise.all(
      heartbeats.map(async (hb) => {
        // Check if account is linked to this workspace
        const linked = await db.query.accountWorkspaces.findFirst({
          where: eq(accountWorkspaces.accountId, hb.accountId),
          columns: { workspaceId: true },
        });
        const hasAccess =
          (linked && linked.workspaceId === id) ||
          workspace?.accessMode === 'open';

        if (!hasAccess) return null;

        const now = Date.now();
        const lastBeat = new Date(hb.lastHeartbeatAt).getTime();
        const staleThreshold = 2 * 60 * 1000; // 2 minutes for "online" status
        const isOnline = now - lastBeat < staleThreshold;

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
          capacity: Math.max(0, hb.maxConcurrentWorkers - hb.activeWorkerCount),
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
