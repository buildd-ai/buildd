import { db } from '@buildd/core/db';
import { accountWorkspaces, accounts, teamMembers, workerHeartbeats, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { accountReachesWorkspace, type ReachWorkspace } from './workspace-reach';
import type { BrowserRunnerHeartbeat } from './visual-audit-runner';
import {
  isPushOnlyRunner,
  isRunnerOnline,
  mountAllowlistEnforcedFrom,
  RUNNER_ONLINE_WINDOW_MS,
  type RunnerHeartbeat,
} from './runner-heartbeats-shared';
import { heartbeatAccountIds, type RunnerHeartbeatLike, type RunnerWorkerLike } from './runner-display';
import { RUNNER_STALE_CUTOFF_MS, resolveWorkspaceExecutor, runnerFleetIdentity, readIsolationRecord } from '@buildd/shared';
import { runnerLiveCandidateCutoff, withLiveRunnerBeats } from './runner-beats';
import { classifyRunnerOwnership, isViewersPersonalRunner } from './runner-ownership';
import { liveLinkCondition } from './granted-links';

// Pure helpers and types live in ./runner-heartbeats-shared so client
// components can import them without pulling `@buildd/core/db` (and its
// `dotenv.config()` call) into the browser bundle. Re-export them here for
// server-side callers that already depend on this module.
export {
  isRunnerOnline,
  isPushOnlyRunner,
  deriveSandboxPosture,
  mountAllowlistEnforcedFrom,
  selectRelevantRunnerAccounts,
  type RunnerHeartbeat,
  type RunnerRelevanceCandidate,
} from './runner-heartbeats-shared';

/**
 * Fetch runner heartbeats seen within the past 150 minutes that are relevant
 * to the given team and workspace scope (see selectRelevantRunnerAccounts).
 * Runner accounts often live in the owner's personal team while serving
 * another team's open workspaces, so scoping by accounts.teamId alone
 * hides them.
 */
export async function getRunnerHeartbeats(
  teamId: string,
  workspaceIds: string[],
  viewerUserId: string | null = null,
): Promise<RunnerHeartbeat[]> {
  if (workspaceIds.length === 0) return [];

  // "Not dead" window — see the window table in @buildd/shared runner-liveness.
  // Relevance (selectRelevantRunnerAccounts) is decided in the query itself
  // (spec 3ef37387 R-23): the account is this team's, holds a live claim link
  // to a scoped workspace, or has worked in one. Only the columns the page
  // shows come back; of the environment, only the two keys it reads.
  const cutoff = new Date(Date.now() - RUNNER_STALE_CUTOFF_MS);
  const wsList = sql.join(workspaceIds.map(id => sql`${id}::uuid`), sql`, `);
  const rows = await db
    .select({
      id: workerHeartbeats.id,
      accountId: workerHeartbeats.accountId,
      localUiUrl: workerHeartbeats.localUiUrl,
      lastHeartbeatAt: workerHeartbeats.lastHeartbeatAt,
      activeWorkerCount: workerHeartbeats.activeWorkerCount,
      maxConcurrentWorkers: workerHeartbeats.maxConcurrentWorkers,
      sandboxEnabled: workerHeartbeats.sandboxEnabled,
      sandboxProbeAt: workerHeartbeats.sandboxProbeAt,
      modelAuthSource: workerHeartbeats.modelAuthSource,
      codexAuthSource: workerHeartbeats.codexAuthSource,
      desiredSlots: workerHeartbeats.desiredSlots,
      desiredSlotsOrigin: workerHeartbeats.desiredSlotsOrigin,
      desiredSlotsSetBy: workerHeartbeats.desiredSlotsSetBy,
      desiredSlotsSetAt: workerHeartbeats.desiredSlotsSetAt,
      // isSharedRunner in SQL: more than one person across the runner's own
      // team and the team it serves here.
      shared: sql<boolean>`(select count(distinct ${teamMembers.userId}) from ${teamMembers} where ${teamMembers.teamId} in (${accounts.teamId}, ${teamId}::uuid)) > 1`,
      environment: sql<{ envKeys?: string[]; isolation?: unknown } | null>`jsonb_build_object('envKeys', ${workerHeartbeats.environment}->'envKeys', 'isolation', ${workerHeartbeats.environment}->'isolation')`,
      account: {
        name: accounts.name,
        teamId: accounts.teamId,
        createdByUserId: accounts.createdByUserId,
        managedRunner: accounts.managedRunner,
        hostRunner: accounts.hostRunner,
        authType: accounts.authType,
      },
    })
    .from(workerHeartbeats)
    .innerJoin(accounts, eq(accounts.id, workerHeartbeats.accountId))
    .where(and(
      gt(workerHeartbeats.lastHeartbeatAt, cutoff),
      or(
        eq(accounts.teamId, teamId),
        sql`exists (select 1 from ${accountWorkspaces} where ${accountWorkspaces.accountId} = ${workerHeartbeats.accountId} and ${accountWorkspaces.workspaceId} in (${wsList}) and ${liveLinkCondition()})`,
        sql`exists (select 1 from ${workers} where ${workers.accountId} = ${workerHeartbeats.accountId} and ${workers.workspaceId} in (${wsList}))`,
      ),
    ))
    .orderBy(desc(workerHeartbeats.lastHeartbeatAt));
  if (rows.length === 0) return [];

  // A stored beat can be one write interval old; the Redis beat is "now" (lib/runner-beats.ts).
  const kept = await withLiveRunnerBeats(rows);

  // Owners and admins of a runner's team may change its slots (R-23).
  const adminTeams = new Set<string>();
  if (viewerUserId) {
    const roles = await db
      .select({ teamId: teamMembers.teamId, role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, viewerUserId), inArray(teamMembers.role, ['owner', 'admin'])));
    for (const r of roles) adminTeams.add(r.teamId);
  }

  return kept
    .map((hb: any) => ({
      id: hb.id,
      accountId: hb.accountId,
      accountName: hb.account?.name ?? null,
      lastHeartbeatAt: new Date(hb.lastHeartbeatAt).toISOString(),
      activeWorkerCount: hb.activeWorkerCount,
      maxConcurrentWorkers: hb.maxConcurrentWorkers,
      connectivity: isPushOnlyRunner(hb.localUiUrl) ? 'push_only' as const : 'reachable' as const,
      sandboxEnabled: hb.sandboxEnabled ?? null,
      sandboxProbeAt: hb.sandboxProbeAt ? (hb.sandboxProbeAt as Date).toISOString() : null,
      // The runner advertises `sandbox:mount-allowlist` only when isolation is
      // actually enforced; without this the dashboard could report kernel
      // capability only. See deriveSandboxPosture.
      mountAllowlistEnforced: mountAllowlistEnforcedFrom(hb.environment as { envKeys?: string[] } | null),
      isolation: readIsolationRecord(hb.environment),
      modelAuthSource: hb.modelAuthSource ?? null,
      codexAuthSource: hb.codexAuthSource ?? null,
      shared: hb.shared !== false,
      runnerClass: classifyRunnerOwnership(hb.account),
      authType: hb.account?.authType === 'oauth' || hb.account?.authType === 'api' ? hb.account.authType : undefined,
      mine: isViewersPersonalRunner(hb.account, viewerUserId),
      slots: {
        desired: hb.desiredSlots ?? null,
        origin: hb.desiredSlotsOrigin ?? null,
        setBy: hb.desiredSlotsSetBy ?? null,
        setAt: hb.desiredSlotsSetAt ? new Date(hb.desiredSlotsSetAt).toISOString() : null,
        canEdit: !!hb.account?.teamId && adminTeams.has(hb.account.teamId),
      },
    }));
}

/**
 * The heartbeats `resolveRunnerDisplay` names runners from, for workers a page
 * already holds (mission Board/Lanes, task page): every runner of those
 * workers' own accounts, so a CI-retry worker read later in the same render on
 * a sibling runner still resolves. Never another account's: a `localhost` URL
 * is shared by every team's runners, and a hostname label must not cross.
 * Best-effort: on any failure the page falls back to the URL's host.
 */
export async function loadRunnerHeartbeats(workerRows: readonly RunnerWorkerLike[]): Promise<RunnerHeartbeatLike[]> {
  const accountIds = heartbeatAccountIds(workerRows);
  if (accountIds.length === 0) return [];
  try {
    const rows = await db
      .select({
        accountId: workerHeartbeats.accountId,
        localUiUrl: workerHeartbeats.localUiUrl,
        environment: workerHeartbeats.environment,
      })
      .from(workerHeartbeats)
      .where(inArray(workerHeartbeats.accountId, accountIds));
    return rows.map(r => ({
      accountId: r.accountId,
      localUiUrl: r.localUiUrl,
      environment: { labels: (r.environment as { labels?: Record<string, string> | null } | null)?.labels ?? null },
    }));
  } catch {
    return [];
  }
}

/**
 * Whether a runner able to claim each workspace's work has heartbeated inside
 * the online window, by the claim rule (`loadBrowserRunnerHeartbeats`), never
 * the deprecated `workerHeartbeats.workspaceIds`. A workspace whose lookup
 * failed is absent from the map: unknown reads as "no claim", never as "no
 * runner".
 */
export async function loadRunnerOnlineByWorkspace(workspaceIds: readonly string[], now: number = Date.now()): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const ids = [...new Set(workspaceIds)];
  if (ids.length === 0) return out;
  try {
    const rows = await db.query.workspaces.findMany({
      where: sqlWhere(inArray(workspaces.id, ids)),
      columns: { id: true, teamId: true, accessMode: true, gitConfig: true, webhookConfig: true },
    });
    await Promise.all(rows.map(async ws => {
      const hbs = await loadBrowserRunnerHeartbeats(ws as Parameters<typeof loadBrowserRunnerHeartbeats>[0], now);
      if (hbs) out.set(ws.id, hbs.some(h => h.workspaceIds.includes(ws.id) && isRunnerOnline(h.lastHeartbeatAt, now)));
    }));
  } catch (err) {
    console.error('[runner-presence] lookup failed:', err);
  }
  return out;
}

/**
 * Fresh heartbeats for `browserRunnerOnline` (visual-audit-runner.ts), with
 * `workspaceIds` resolved per account by the claim rule
 * (`accountReachesWorkspace` with `canClaim`): a claim link, or an open
 * workspace of the account's own team. The stored `workspace_ids` column is
 * deprecated and always empty, so it is never read.
 *
 * Two reads, and only when the visual review model asks (a claimable audit
 * pending past NO_BROWSER_RUNNER_AFTER_MS). Best-effort: on failure it
 * returns null, which the model reads as "unknown" and never as "no runner".
 */
export async function loadBrowserRunnerHeartbeats(
  workspace: { id: string; gitConfig?: unknown; webhookConfig?: { enabled?: unknown; events?: unknown } | null } & ReachWorkspace,
  now: number,
): Promise<BrowserRunnerHeartbeat[] | null> {
  try {
    const cutoff = runnerLiveCandidateCutoff(now, RUNNER_ONLINE_WINDOW_MS);
    const candidates = await db
      .select({
        accountId: workerHeartbeats.accountId,
        localUiUrl: workerHeartbeats.localUiUrl,
        lastHeartbeatAt: workerHeartbeats.lastHeartbeatAt,
        environment: workerHeartbeats.environment,
        accountTeamId: accounts.teamId,
      })
      .from(workerHeartbeats)
      .innerJoin(accounts, eq(accounts.id, workerHeartbeats.accountId))
      .where(gt(workerHeartbeats.lastHeartbeatAt, cutoff));
    const hbs = (await withLiveRunnerBeats(candidates))
      .filter(h => now - h.lastHeartbeatAt.getTime() < RUNNER_ONLINE_WINDOW_MS);
    if (hbs.length === 0) return [];
    const accountIds = [...new Set(hbs.map(h => h.accountId))];
    const links = await db
      .select({ accountId: accountWorkspaces.accountId, canClaim: accountWorkspaces.canClaim, canCreate: accountWorkspaces.canCreate })
      .from(accountWorkspaces)
      .where(and(inArray(accountWorkspaces.accountId, accountIds), eq(accountWorkspaces.workspaceId, workspace.id), liveLinkCondition()));
    const linkOf = new Map(links.map(l => [l.accountId, l]));
    return hbs.map(h => ({
      accountId: h.accountId,
      localUiUrl: h.localUiUrl,
      lastHeartbeatAt: h.lastHeartbeatAt,
      environment: (h.environment as { envKeys?: string[] } | null) ?? null,
      workspaceIds: (() => {
        const executor = resolveWorkspaceExecutor(workspace.gitConfig as Parameters<typeof resolveWorkspaceExecutor>[0], workspace.webhookConfig).executor;
        return executor === 'any' || (runnerFleetIdentity({ localUiUrl: h.localUiUrl, environment: h.environment }).executor ?? 'host') === executor;
      })() && accountReachesWorkspace({ teamId: h.accountTeamId }, workspace, linkOf.get(h.accountId) ?? null, 'canClaim')
        ? [workspace.id]
        : [],
    }));
  } catch (err) {
    console.error('[visual-review] browser runner lookup failed:', err);
    return null;
  }
}
