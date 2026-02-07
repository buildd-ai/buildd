import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accountWorkspaces, accounts, workerHeartbeats, workspaces } from '@buildd/core/db/schema';
import { eq, gt } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';

const HEARTBEAT_STALE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * GET /api/workers/active
 *
 * Returns active local-ui instances with capacity.
 * Supports dual auth: API key (Bearer) or session cookie.
 *
 * Response includes:
 * - localUiUrl: The URL to access the local-ui
 * - activeWorkers: Number of currently active workers
 * - maxConcurrent: Maximum concurrent workers allowed
 * - capacity: Remaining capacity (maxConcurrent - activeWorkers)
 * - workspaceIds: Workspaces this local-ui can work on
 */

async function authenticateRequest(req: NextRequest) {
  // Try API key first
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
    if (account) return { type: 'api' as const, account };
  }

  // Fall back to session
  const user = await getCurrentUser();
  if (user) return { type: 'session' as const, user };

  return null;
}

async function getWorkspaceIdsAndNames(auth: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>) {
  if (auth.type === 'api') {
    // API key auth: get workspaces via accountWorkspaces join table
    const aw = await db.query.accountWorkspaces.findMany({
      where: eq(accountWorkspaces.accountId, auth.account.id),
      with: { workspace: { columns: { id: true, name: true } } },
    });
    return aw.map(a => ({ id: a.workspace.id, name: a.workspace.name }));
  }
  // Session auth: get workspaces owned by user
  return db.query.workspaces.findMany({
    where: eq(workspaces.ownerId, auth.user.id),
    columns: { id: true, name: true },
  });
}

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const userWorkspaces = await getWorkspaceIdsAndNames(auth);
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
