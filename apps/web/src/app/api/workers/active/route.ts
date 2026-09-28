import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, workerHeartbeats, workspaces } from '@buildd/core/db/schema';
import { eq, gt, inArray, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { getCachedOpenWorkspaceIds, setCachedOpenWorkspaceIds } from '@/lib/redis';
import { getUserWorkspaceIds, getUserTeamIds } from '@/lib/team-access';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { getDeployIdentity } from '@/lib/deploy-identity';
import { browserRunnerOnline } from '@/lib/visual-audit-runner';
import { isRunnerOnline, RUNNER_ONLINE_WINDOW_MS } from '@/lib/runner-heartbeats-shared';
import { CAPABILITY_BROWSER } from '@buildd/shared';

// Runner heartbeat fires on the aligned BUILDD_RUNNER_POLL_MIN cycle (default 60 min)
// to let Neon suspend. Stale threshold is 2.5× so a single dropped beat isn't fatal.
const HEARTBEAT_STALE_MS = 150 * 60 * 1000;

/**
 * GET /api/workers/active
 *
 * Returns active runner instances with capacity.
 * Supports dual auth: API key (Bearer) or session cookie.
 *
 * Response includes:
 * - localUiUrl: The URL to access the runner
 * - activeWorkers: Number of currently active workers
 * - maxConcurrent: Maximum concurrent workers allowed
 * - capacity: Remaining capacity (maxConcurrent - activeWorkers)
 * - workspaceIds: Workspaces this runner can work on
 * - browser: the heartbeat advertises the `browser` capability (envKeys)
 * - browserOnline: `browser`, a heartbeat within `onlineWindowMs`, and (with
 *   `?workspaceId=`) claim reach there: the same rule as `browserRunnerOnline`
 *
 * `?workspaceId=` (one the caller can see, else 404) adds `workspace` and
 * `browserRunnerOnline` for it: `browserRunnerOnline` over heartbeats resolved
 * by the claim rule (`loadBrowserRunnerHeartbeats`), the visual review's own
 * answer; null when the lookup failed.
 */

async function authenticateRequest(req: NextRequest) {
  // Try API key first (uses cached auth)
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    if (account) return { type: 'api' as const, account };
  }

  // Fall back to session
  const user = await getCurrentUser();
  if (user) return { type: 'session' as const, user };

  return null;
}

async function getWorkspaceIdsAndNames(auth: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>) {
  if (auth.type === 'api') {
    // API key auth: get workspaces via cached permissions + open workspaces
    const permissions = await getAccountWorkspacePermissions(auth.account.id);
    const linkedWsIds = permissions.map(p => p.workspaceId);
    const linkedWs = linkedWsIds.length > 0
      ? await db.query.workspaces.findMany({
          where: inArray(workspaces.id, linkedWsIds),
          columns: { id: true, name: true },
        })
      : [];
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
    for (const w of linkedWs) {
      if (!seen.has(w.id)) { seen.add(w.id); result.push(w); }
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

    const askedWorkspaceId = new URL(req.url).searchParams.get('workspaceId');
    if (askedWorkspaceId && !workspaceIds.includes(askedWorkspaceId)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

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
          inArray(workers.status, [...LIVE_WORKER_STATUSES]),
        ),
        columns: { accountId: true },
      });
      for (const w of activeWorkerRecords) {
        if (w.accountId) {
          actualWorkerCounts.set(w.accountId, (actualWorkerCounts.get(w.accountId) || 0) + 1);
        }
      }
    }

    // Deployed sha, read once — zero network cost, from build-time env (see
    // getDeployIdentity). This is the "behind" comparison for a runner
    // tracking `main`, which is also the only branch Vercel deploys from (see
    // CLAUDE.md); a runner tracking `dev` has nothing to compare against here
    // and gets `upToDateWithDeployed: null` rather than a wrong answer.
    const deployedSha = getDeployIdentity().sha;

    // Filter to only heartbeats that have access to user's workspaces
    const activeLocalUis = await Promise.all(
      heartbeats.map(async hb => {
        // Compute which workspaces this heartbeat can access (cached)
        const permissions = await getAccountWorkspacePermissions(hb.accountId);
        const hbWorkspaceIds = [
          ...permissions.map(p => p.workspaceId),
          ...openWorkspaceIds!,
        ];

        const overlapping = hbWorkspaceIds.filter(id => workspaceIds.includes(id));
        if (overlapping.length === 0) return null;

        // Use the higher of heartbeat-reported count and actual DB count
        // This catches cases where runner reports 0 but workers are still 'running' in DB
        const reportedCount = hb.activeWorkerCount;
        const dbCount = actualWorkerCounts.get(hb.accountId) || 0;
        const effectiveActiveWorkers = Math.max(reportedCount, dbCount);
        const envKeys = (hb.environment as { envKeys?: unknown } | null)?.envKeys;

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
          environment: hb.environment || null,
          browser: Array.isArray(envKeys) && envKeys.includes(CAPABILITY_BROWSER),
          runnerCommit: hb.runnerCommit || null,
          runnerVersion: hb.runnerVersion || null,
          // The runner's own live update-state — same fields it reports on
          // its local /api/version, now visible without SSH into the host.
          currentCommit: hb.currentCommit || null,
          diskCommit: hb.diskCommit || null,
          commitDrift: hb.commitDrift ?? null,
          updating: hb.updating ?? null,
          updateAvailable: hb.updateAvailable ?? null,
          // Set the moment updateAvailable first flipped true; null while
          // up to date. Makes "how long has it been behind" a measured value
          // instead of something inferred from boot age.
          updateAvailableSince: hb.updateAvailableSince ?? null,
          trackedBranch: hb.trackedBranch || null,
          // Only meaningful for a `main`-tracking runner (Vercel deploys from
          // `main` only) with both sides known; otherwise null, not a guess.
          upToDateWithDeployed: hb.trackedBranch === 'main' && hb.diskCommit && deployedSha
            ? hb.diskCommit === deployedSha
            : null,
          lastUpdated: hb.lastHeartbeatAt,
        };
      })
    );

    // Filter out nulls and sort by capacity (most available first)
    const validLocalUis = activeLocalUis.filter((x): x is NonNullable<typeof x> => x !== null);
    validLocalUis.sort((a, b) => b.capacity - a.capacity);

    // `browserOnline` per runner is the summary's rule (browserRunnerOnline):
    // a heartbeat inside RUNNER_ONLINE_WINDOW_MS, the browser capability and,
    // for an asked workspace, claim reach. `browser` alone is the capability.
    const now = Date.now();
    if (askedWorkspaceId) {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, askedWorkspaceId),
        columns: { id: true, teamId: true, accessMode: true },
      });
      const { loadBrowserRunnerHeartbeats } = await import('@/lib/runner-heartbeats');
      const hbs = ws ? await loadBrowserRunnerHeartbeats(ws, now) : null;
      const claimers = hbs ? new Set(hbs.filter(h => h.workspaceIds.includes(askedWorkspaceId)).map(h => h.accountId)) : null;
      return NextResponse.json({
        activeLocalUis: validLocalUis.map(r => {
          const canClaimInWorkspace = claimers ? claimers.has(r.accountId) : null;
          return { ...r, canClaimInWorkspace, browserOnline: r.browser && isRunnerOnline(r.lastUpdated, now) && canClaimInWorkspace === true };
        }),
        onlineWindowMs: RUNNER_ONLINE_WINDOW_MS,
        workspace: { id: askedWorkspaceId, name: workspaceNameMap.get(askedWorkspaceId) ?? null },
        browserRunnerOnline: hbs ? browserRunnerOnline(hbs, askedWorkspaceId, now) : null,
      });
    }

    return NextResponse.json({
      activeLocalUis: validLocalUis.map(r => ({ ...r, browserOnline: r.browser && isRunnerOnline(r.lastUpdated, now) })),
      onlineWindowMs: RUNNER_ONLINE_WINDOW_MS,
    });
  } catch (error) {
    console.error('Get active workers error:', error);
    return NextResponse.json({ error: 'Failed to get active workers' }, { status: 500 });
  }
}
