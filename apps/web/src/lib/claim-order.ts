/**
 * The claim route's own order and reach, shared so a read of "what this runner
 * takes next" cannot drift from what POST /api/workers/claim does.
 *
 *   - claimOrderBy: the candidate query's ORDER BY (priority, then age).
 *   - claimableWorkspaceIds: the workspaces an account may claim from; every
 *     candidate and taskId lookup in the claim route is bounded by it.
 *   - activeWorkerGate / runnerPreferenceGate / runnerCooldownGate: claim
 *     predicates the route used to build inline. TRUE when the task passes.
 *
 * The claim route (app/api/workers/claim/route.ts) and the runner queue read
 * (lib/claim-order-queue.ts, GET /api/workers/queue) both import these.
 * Spec c7410e76 R-26.
 */
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import { constrainToGranted, isGrantSession, type GrantScopedAccount } from '@/lib/grant-scope';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';

type OrderOps = { desc: (c: any) => any; asc: (c: any) => any };

/** The claim candidate query's ORDER BY: highest priority first, then oldest first. */
export function claimOrderBy(t: typeof tasks, { desc, asc }: OrderOps) {
  return [desc(t.priority), asc(t.createdAt)];
}

/** JS mirror of claimOrderBy, for a list already read. Keep the two in step. */
export function compareClaimOrder(
  a: { priority: number | null; createdAt: Date | string },
  b: { priority: number | null; createdAt: Date | string },
): number {
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pa !== pb) return pb - pa;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

export type ClaimScopeAccount = GrantScopedAccount & { id: string; teamId: string };

/**
 * Workspaces this account can claim from, optionally narrowed to one.
 *
 *   1. A grant session: its granted workspaces (grant ∩ current membership,
 *      this request), whatever the shared team account would allow.
 *   2. Otherwise: open workspaces of the account's own team ("open" = open
 *      within the team), plus any workspace with an explicit canClaim link that
 *      still exists and is not revoked, cut to a workspace-restricted token's
 *      own list.
 */
export async function claimableWorkspaceIds(account: ClaimScopeAccount, workspaceId?: string | null): Promise<string[]> {
  // A grant session claims only inside its granted workspaces (lib/grant-scope.ts).
  if (isGrantSession(account)) {
    return constrainToGranted(account, account.workspaceIds ?? [], 'write')
      .filter((id) => !workspaceId || id === workspaceId);
  }
  const openWorkspaces = await db.query.workspaces.findMany({
    where: sqlWhere(and(
      eq(workspaces.accessMode, 'open'),
      eq(workspaces.teamId, account.teamId),
      workspaceId ? eq(workspaces.id, workspaceId) : undefined
    )),
  });

  // Cached account→workspace permissions (avoids a DB hit on every claim). A
  // workspace a person picked for this key (granted_by_user_id) is re-checked
  // live on every call: their membership and role in its team and its access
  // mode now (lib/granted-links.ts). A pick that no longer holds comes back
  // `revoked` and is kept out below, even where the open arm would reach it.
  const allPermissions = await getAccountWorkspacePermissions(account.id, { includeRevoked: true });
  const revokedIds = new Set(allPermissions.filter((p) => p.revoked).map((p) => p.workspaceId));
  const claimablePermissions = allPermissions
    .filter((p) => p.canClaim && !p.revoked)
    .filter((p) => !workspaceId || p.workspaceId === workspaceId);

  // Resolve which linked workspaces still exist. An explicit canClaim link
  // grants access whatever the workspace's accessMode — it is how an account
  // outside the owning team is given access to an open workspace.
  const restrictedWsIds = claimablePermissions.map((p) => p.workspaceId);
  let restrictedIds: string[] = [];
  if (restrictedWsIds.length > 0) {
    const restrictedWorkspaces = await db.query.workspaces.findMany({
      where: sqlWhere(inArray(workspaces.id, restrictedWsIds)),
      columns: { id: true },
    });
    restrictedIds = restrictedWorkspaces.map((ws) => ws.id);
  }

  const openIds = openWorkspaces.map((ws) => ws.id);

  // A workspace-restricted token claims only inside its own list, whatever
  // the team's open workspaces or canClaim links would otherwise allow.
  return [...new Set([...openIds, ...restrictedIds])]
    .filter((id) => !revokedIds.has(id))
    .filter((id) => tokenWorkspaceAllowed(account.workspaceIds, id));
}

/**
 * TRUE when the task has no live worker. Keeps a duplicate claim off a task
 * stale cleanup reset to pending while another worker is still active.
 */
export function activeWorkerGate(): SQL {
  return sql`NOT EXISTS (
      SELECT 1 FROM ${workers} w
      WHERE w.task_id = ${tasks.id}
      AND w.status IN ('running', 'starting', 'waiting_input', 'idle')
    )`;
}

/** TRUE when the task lets this kind of account run it (runnerPreference any, or this type). */
export function runnerPreferenceGate(accountType: string): SQL {
  return or(eq(tasks.runnerPreference, 'any'), eq(tasks.runnerPreference, accountType as any))!;
}

/**
 * Per-runner claim cooldown after a worker error. Matches the typical
 * client-side breaker minimum (5m for generic errors, 60s default here since
 * the dominant burn-loop cause is fast-fail budget/auth errors that bounce in
 * <1s). Scoped per-runner so healthy runners keep picking up tasks.
 */
export const CLAIM_COOLDOWN_MS = 60_000;

/**
 * Per-runner cooldown: TRUE unless this runner had a worker error or fail on
 * the task since `cutoff`. Scoped by runner so a healthy runner can still take it.
 */
export function runnerCooldownGate(runner: string, cutoff: Date): SQL {
  return sql`NOT EXISTS (
        SELECT 1 FROM ${workers} w_cd
        WHERE w_cd.task_id = ${tasks.id}
        AND w_cd.runner = ${runner}
        AND w_cd.status IN ('error', 'failed')
        AND w_cd.updated_at > ${cutoff}
      )`;
}
