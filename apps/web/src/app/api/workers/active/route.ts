import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accountWorkspaces, accounts, workers, workerHeartbeats, workspaces } from '@buildd/core/db/schema';
import { eq, gt, inArray, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { getCachedOpenWorkspaceIds, setCachedOpenWorkspaceIds } from '@/lib/redis';
import { getUserWorkspaceIds, getUserTeamIds } from '@/lib/team-access';

const HEARTBEAT_STALE_MS = 10 * 60 * 1000; // 10 minutes (heartbeat every 5 min + buffer)

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
    // Try Redis cache first for open workspaces
    let openWorkspaceIds = await getCachedOpenWorkspaceIds();
    let openWs: { id: string; name: string }[];
    if (openWorkspaceIds) {
      // Cache hit - fetch names only for the cached IDs
      openWs = await db.query.workspaces.findMany({
        where: inArray(workspaces.id, openWorkspaceIds),
        columns: { id: true, name: true },
      });
    } else {
      // Cache miss - query DB and cache IDs
      openWs = await db.query.workspaces.findMany({
        where: eq(workspaces.accessMode, 'open'),
        columns: { id: true, name: true },
        limit: 100,
      });
      await setCachedOpenWorkspaceIds(openWs.map(w => w.id));
    }
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
  // Session auth: get workspaces via team membership + open workspaces
  const teamWsIds = await getUserWorkspaceIds(auth.user.id);
  let teamWs: { id: string; name: string }[] = [];
  if (teamWsIds.length > 0) {
    teamWs = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, teamWsIds),
      columns: { id: true, name: true },
    });
  }
  // Try Redis cache first for open workspaces
  let openWorkspaceIds = await getCachedOpenWorkspaceIds();
  let openWs: { id: string; name: string }[];
  if (openWorkspaceIds) {
    openWs = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, openWorkspaceIds),
      columns: { id: true, name: true },
    });
  } else {
    openWs = await db.query.workspaces.findMany({
      where: eq(workspaces.accessMode, 'open'),
      columns: { id: true, name: true },
      limit: 100,
    });
    await setCachedOpenWorkspaceIds(openWs.map(w => w.id));
  }
  const seen = new Set<string>();
  const result: { id: string; name: string }[] = [];
  for (const w of teamWs) {
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

    // Compute workspace access on-demand for each heartbeat
    // Cache open workspaces once for all heartbeats
    let openWorkspaceIds = await getCachedOpenWorkspaceIds();
    if (!openWorkspaceIds) {
      const openWs = await db.query.workspaces.findMany({
        where: eq(workspaces.accessMode, 'open'),
        columns: { id: true },
        limit: 100,
      });
      openWorkspaceIds = openWs.map(w => w.id);
      await setCachedOpenWorkspaceIds(openWorkspaceIds);
    }

    // Cross-reference with actual running workers from DB for each account
    // This prevents showing stale capacity when workers are stuck
    const accountIds = [...new Set(heartbeats.map(hb => hb.accountId))];
    const actualWorkerCounts = new Map<string, number>();
    if (accountIds.length > 0) {
      const activeWorkerRecords = await db.query.workers.findMany({
        where: and(
          inArray(workers.accountId, accountIds),
          inArray(workers.status, ['idle', 'running', 'starting', 'waiting_input', 'awaiting_plan_approval']),
        ),
        columns: { accountId: true },
      });
      for (const w of activeWorkerRecords) {
        if (w.accountId) {
          actualWorkerCounts.set(w.accountId, (actualWorkerCounts.get(w.accountId) || 0) + 1);
        }
      }
    }

    // Filter to only heartbeats that have access to user's workspaces
    const activeLocalUis = await Promise.all(
      heartbeats.map(async hb => {
        // Compute which workspaces this heartbeat can access
        const accountWs = await db.query.accountWorkspaces.findMany({
          where: eq(accountWorkspaces.accountId, hb.accountId),
          columns: { workspaceId: true },
        });
        const hbWorkspaceIds = [
          ...accountWs.map(aw => aw.workspaceId),
          ...openWorkspaceIds!,
        ];

        const overlapping = hbWorkspaceIds.filter(id => workspaceIds.includes(id));
        if (overlapping.length === 0) return null;

        // Use the higher of heartbeat-reported count and actual DB count
        // This catches cases where local-ui reports 0 but workers are still 'running' in DB
        const reportedCount = hb.activeWorkerCount;
        const dbCount = actualWorkerCounts.get(hb.accountId) || 0;
        const effectiveActiveWorkers = Math.max(reportedCount, dbCount);

        return {
          localUiUrl: hb.localUiUrl,
          viewerToken: hb.viewerToken,
          accountId: hb.accountId,
          accountName: hb.account?.name || 'Unknown',
          maxConcurrent: hb.maxConcurrentWorkers,
          activeWorkers: effectiveActiveWorkers,
          capacity: Math.max(0, hb.maxConcurrentWorkers - effectiveActiveWorkers),
          workspaceIds: overlapping,
          workspaceNames: overlapping.map(id => workspaceNameMap.get(id) || 'Unknown'),
          lastUpdated: hb.lastHeartbeatAt,
        };
      })
    );

    // Filter out nulls and sort by capacity (most available first)
    const validLocalUis = activeLocalUis.filter((x): x is NonNullable<typeof x> => x !== null);
    validLocalUis.sort((a, b) => b.capacity - a.capacity);

    return NextResponse.json({ activeLocalUis: validLocalUis });
  } catch (error) {
    console.error('Get active workers error:', error);
    return NextResponse.json({ error: 'Failed to get active workers' }, { status: 500 });
  }
}
