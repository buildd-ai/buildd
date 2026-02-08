import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accountWorkspaces, accounts, workerHeartbeats, workspaces } from '@buildd/core/db/schema';
import { eq, gt, inArray } from 'drizzle-orm';
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
    // API key auth: get workspaces via accountWorkspaces join table + open workspaces
    const aw = await db.query.accountWorkspaces.findMany({
      where: eq(accountWorkspaces.accountId, auth.account.id),
      with: { workspace: { columns: { id: true, name: true } } },
    });
    const openWs = await db.query.workspaces.findMany({
      where: eq(workspaces.accessMode, 'open'),
      columns: { id: true, name: true },
      limit: 100, // Limit open workspaces to prevent excessive data transfer
    });
    const seen = new Set<string>();
    const result: { id: string; name: string }[] = [];
    for (const a of aw) {
      if (!seen.has(a.workspace.id)) { seen.add(a.workspace.id); result.push(a.workspace); }
    }
    for (const w of openWs) {
      if (!seen.has(w.id)) { seen.add(w.id); result.push(w); }
    }
    return result;
  }
  // Session auth: get workspaces owned by user + accessible through their accounts + open
  const ownedWs = await db.query.workspaces.findMany({
    where: eq(workspaces.ownerId, auth.user.id),
    columns: { id: true, name: true },
  });
  // Workspaces accessible through user's accounts
  const userAccounts = await db.query.accounts.findMany({
    where: eq(accounts.ownerId, auth.user.id),
    columns: { id: true },
  });
  let linkedWs: { id: string; name: string }[] = [];
  if (userAccounts.length > 0) {
    const allAw = await db.query.accountWorkspaces.findMany({
      where: inArray(accountWorkspaces.accountId, userAccounts.map(a => a.id)),
      with: { workspace: { columns: { id: true, name: true } } },
    });
    linkedWs = allAw.map(a => a.workspace);
  }
  const openWs = await db.query.workspaces.findMany({
    where: eq(workspaces.accessMode, 'open'),
    columns: { id: true, name: true },
    limit: 100, // Limit open workspaces to prevent excessive data transfer
  });
  const seen = new Set<string>();
  const result: { id: string; name: string }[] = [];
  for (const w of ownedWs) {
    if (!seen.has(w.id)) { seen.add(w.id); result.push(w); }
  }
  for (const w of linkedWs) {
    if (!seen.has(w.id)) { seen.add(w.id); result.push(w); }
  }
  for (const w of openWs) {
    if (!seen.has(w.id)) { seen.add(w.id); result.push(w); }
  }
  return result;
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
