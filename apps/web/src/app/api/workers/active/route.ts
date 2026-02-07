import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats, workspaces } from '@buildd/core/db/schema';
import { eq, gt, and, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

const HEARTBEAT_STALE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * GET /api/workers/active
 *
 * Returns active local-ui instances with capacity for the current user.
 * Uses the workerHeartbeats table - instances that have pinged within
 * the last 2 minutes are considered alive.
 *
 * Response includes:
 * - localUiUrl: The URL to access the local-ui
 * - activeWorkers: Number of currently active workers
 * - maxConcurrent: Maximum concurrent workers allowed
 * - capacity: Remaining capacity (maxConcurrent - activeWorkers)
 * - workspaceIds: Workspaces this local-ui can work on
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Get user's workspace IDs
    const userWorkspaces = await db.query.workspaces.findMany({
      where: eq(workspaces.ownerId, user.id),
      columns: { id: true, name: true },
    });
    const workspaceIds = userWorkspaces.map(w => w.id);
    const workspaceNameMap = new Map(userWorkspaces.map(w => [w.id, w.name]));

    if (workspaceIds.length === 0) {
      return NextResponse.json({ activeLocalUis: [] });
    }

    // Find heartbeats that are recent (within last 2 minutes)
    const cutoff = new Date(Date.now() - HEARTBEAT_STALE_MS);
    const heartbeats = await db.query.workerHeartbeats.findMany({
      where: gt(workerHeartbeats.lastHeartbeatAt, cutoff),
      with: {
        account: {
          columns: { id: true, name: true, maxConcurrentWorkers: true },
        },
      },
    });

    // Filter to only heartbeats whose workspaceIds overlap with user's workspaces
    const activeLocalUis = heartbeats
      .map(hb => {
        const hbWorkspaceIds = (hb.workspaceIds || []) as string[];
        const overlapping = hbWorkspaceIds.filter(id => workspaceIds.includes(id));
        if (overlapping.length === 0) return null;

        return {
          localUiUrl: hb.localUiUrl,
          viewerToken: hb.viewerToken,
          accountId: hb.accountId,
          accountName: hb.account?.name || 'Unknown',
          maxConcurrent: hb.maxConcurrentWorkers,
          activeWorkers: hb.activeWorkerCount,
          capacity: Math.max(0, hb.maxConcurrentWorkers - hb.activeWorkerCount),
          workspaceIds: overlapping,
          workspaceNames: overlapping.map(id => workspaceNameMap.get(id) || 'Unknown'),
          lastUpdated: hb.lastHeartbeatAt,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Sort by capacity (most available first)
    activeLocalUis.sort((a, b) => b.capacity - a.capacity);

    return NextResponse.json({ activeLocalUis });
  } catch (error) {
    console.error('Get active workers error:', error);
    return NextResponse.json({ error: 'Failed to get active workers' }, { status: 500 });
  }
}
