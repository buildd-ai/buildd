import { db } from '@buildd/core/db';
import { accountWorkspaces, accounts, workerHeartbeats, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { accountReachesWorkspace, type ReachWorkspace } from './workspace-reach';
import type { BrowserRunnerHeartbeat } from './visual-audit-runner';
import {
  isPushOnlyRunner,
  mountAllowlistEnforcedFrom,
  selectRelevantRunnerAccounts,
  RUNNER_ONLINE_WINDOW_MS,
  type RunnerHeartbeat,
} from './runner-heartbeats-shared';
import { heartbeatAccountIds, type RunnerHeartbeatLike, type RunnerWorkerLike } from './runner-display';

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
): Promise<RunnerHeartbeat[]> {
  if (workspaceIds.length === 0) return [];

  const cutoff = new Date(Date.now() - 150 * 60 * 1000);
  const hbs = await db.query.workerHeartbeats.findMany({
    where: gt(workerHeartbeats.lastHeartbeatAt, cutoff),
    orderBy: desc(workerHeartbeats.lastHeartbeatAt),
    with: { account: { columns: { name: true, teamId: true } } },
  });
  if (hbs.length === 0) return [];

  const hbAccountIds = [...new Set((hbs as any[]).map((hb: any) => hb.accountId as string))];

  const [links, worked] = await Promise.all([
    db
      .select({ accountId: accountWorkspaces.accountId })
      .from(accountWorkspaces)
      .where(and(
        inArray(accountWorkspaces.accountId, hbAccountIds),
        inArray(accountWorkspaces.workspaceId, workspaceIds),
      )),
    db
      .selectDistinct({ accountId: workers.accountId })
      .from(workers)
      .where(and(
        inArray(workers.accountId, hbAccountIds),
        inArray(workers.workspaceId, workspaceIds),
      )),
  ]);

  const relevant = selectRelevantRunnerAccounts(
    (hbs as any[]).map((hb: any) => ({
      accountId: hb.accountId as string,
      accountTeamId: (hb.account?.teamId as string | undefined) ?? null,
    })),
    {
      teamId,
      linkedAccountIds: new Set((links as any[]).map((r: any) => r.accountId as string)),
      workedAccountIds: new Set(
        (worked as any[]).map((r: any) => r.accountId as string | null).filter(Boolean) as string[],
      ),
    },
  );

  return (hbs as any[])
    .filter((hb: any) => relevant.has(hb.accountId))
    .map((hb: any) => ({
      id: hb.id,
      accountId: hb.accountId,
      accountName: hb.account?.name ?? null,
      lastHeartbeatAt: hb.lastHeartbeatAt.toISOString(),
      activeWorkerCount: hb.activeWorkerCount,
      maxConcurrentWorkers: hb.maxConcurrentWorkers,
      connectivity: isPushOnlyRunner(hb.localUiUrl) ? 'push_only' as const : 'reachable' as const,
      sandboxEnabled: hb.sandboxEnabled ?? null,
      sandboxProbeAt: hb.sandboxProbeAt ? (hb.sandboxProbeAt as Date).toISOString() : null,
      // The runner advertises `sandbox:mount-allowlist` only when isolation is
      // actually enforced; without this the dashboard could report kernel
      // capability only. See deriveSandboxPosture.
      mountAllowlistEnforced: mountAllowlistEnforcedFrom(hb.environment as { envKeys?: string[] } | null),
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
  workspace: { id: string } & ReachWorkspace,
  now: number,
): Promise<BrowserRunnerHeartbeat[] | null> {
  try {
    const cutoff = new Date(now - RUNNER_ONLINE_WINDOW_MS);
    const hbs = await db
      .select({
        accountId: workerHeartbeats.accountId,
        lastHeartbeatAt: workerHeartbeats.lastHeartbeatAt,
        environment: workerHeartbeats.environment,
        accountTeamId: accounts.teamId,
      })
      .from(workerHeartbeats)
      .innerJoin(accounts, eq(accounts.id, workerHeartbeats.accountId))
      .where(gt(workerHeartbeats.lastHeartbeatAt, cutoff));
    if (hbs.length === 0) return [];
    const accountIds = [...new Set(hbs.map(h => h.accountId))];
    const links = await db
      .select({ accountId: accountWorkspaces.accountId, canClaim: accountWorkspaces.canClaim, canCreate: accountWorkspaces.canCreate })
      .from(accountWorkspaces)
      .where(and(inArray(accountWorkspaces.accountId, accountIds), eq(accountWorkspaces.workspaceId, workspace.id)));
    const linkOf = new Map(links.map(l => [l.accountId, l]));
    return hbs.map(h => ({
      accountId: h.accountId,
      lastHeartbeatAt: h.lastHeartbeatAt,
      environment: (h.environment as { envKeys?: string[] } | null) ?? null,
      workspaceIds: accountReachesWorkspace({ teamId: h.accountTeamId }, workspace, linkOf.get(h.accountId) ?? null, 'canClaim')
        ? [workspace.id]
        : [],
    }));
  } catch (err) {
    console.error('[visual-review] browser runner lookup failed:', err);
    return null;
  }
}
