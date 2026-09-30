import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, workerHeartbeats, workspaces } from '@buildd/core/db/schema';
import { eq, gt, inArray, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { listOpenWorkspaces, isOpenWithinTeams } from '@/lib/open-workspaces';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { getDeployIdentity } from '@/lib/deploy-identity';
import { browserRunnerOnline } from '@/lib/visual-audit-runner';
import { isRunnerOnline, RUNNER_ONLINE_WINDOW_MS } from '@/lib/runner-heartbeats-shared';
import { CAPABILITY_BROWSER, RUNNER_STALE_CUTOFF_MS } from '@buildd/shared';

// "Not dead" window (2.5× the poll cycle): a runner listed here may be quiet,
// but has not been presumed dead. Presence is judged separately below with
// RUNNER_ONLINE_WINDOW_MS.
const HEARTBEAT_STALE_MS = RUNNER_STALE_CUTOFF_MS;

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

type CallerWorkspace = { id: string; name: string; teamId: string | null; accessMode: string | null };
const CALLER_WS_COLUMNS = { id: true, name: true, teamId: true, accessMode: true } as const;

/**
 * The workspaces the caller can see, by the same rule every workspace list
 * uses (lib/workspace-access.ts): "open" means open within the owning team.
 *
 * - API account: its explicit links, plus its own team's open workspaces.
 * - Session: every workspace of the user's teams, which already includes those
 *   teams' open workspaces. Another team's open workspace is not one of them.
 */
async function getWorkspaceIdsAndNames(
  auth: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>,
): Promise<CallerWorkspace[]> {
  let rows: CallerWorkspace[];
  if (auth.type === 'api') {
    const permissions = await getAccountWorkspacePermissions(auth.account.id);
    const linkedWsIds = permissions.map(p => p.workspaceId);
    const [linkedWs, openWs] = await Promise.all([
      linkedWsIds.length > 0
        ? db.query.workspaces.findMany({
            where: inArray(workspaces.id, linkedWsIds),
            columns: CALLER_WS_COLUMNS,
          })
        : Promise.resolve([]),
      listOpenWorkspaces([auth.account.teamId], CALLER_WS_COLUMNS),
    ]);
    rows = [...linkedWs, ...openWs] as CallerWorkspace[];
  } else {
    const teamWsIds = await getUserWorkspaceIds(auth.user.id);
    rows = teamWsIds.length > 0
      ? (await db.query.workspaces.findMany({
          where: inArray(workspaces.id, teamWsIds),
          columns: CALLER_WS_COLUMNS,
        })) as CallerWorkspace[]
      : [];
  }
  const seen = new Set<string>();
  return rows.filter(w => (seen.has(w.id) ? false : (seen.add(w.id), true)));
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
          columns: { id: true, name: true, maxConcurrentWorkers: true, teamId: true },
        },
      },
    });

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
        // The claim rule (accountReachesWorkspace), over the caller's own
        // workspaces only: an explicit link, or an open workspace of the
        // runner account's OWN team.
        const permissions = await getAccountWorkspacePermissions(hb.accountId);
        const linked = new Set(permissions.map(p => p.workspaceId));
        const accountTeamId = (hb.account as { teamId?: string | null } | null)?.teamId ?? null;
        const overlapping = userWorkspaces
          .filter(w => linked.has(w.id) || (!!accountTeamId && isOpenWithinTeams(w, [accountTeamId])))
          .map(w => w.id);
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
