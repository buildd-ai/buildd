/**
 * The claim route's own order and reach, shared so a read of "what this runner
 * takes next" cannot drift from what POST /api/workers/claim does.
 *
 *   - claimOrderBy: the candidate query's ORDER BY (priority, then age).
 *   - claimableWorkspaceIds: the workspaces an account may claim from; every
 *     candidate and taskId lookup in the claim route is bounded by it.
 *   - activeWorkerGate / runnerPreferenceGate / runnerCooldownGate: claim
 *     predicates the route used to build inline. TRUE when the task passes.
 *   - roleSlugGate / isRoleClaimable: the role routing predicate, kept here so
 *     a core read can apply it (claim/role-gate.ts re-exports it unchanged).
 *
 * The claim route (app/api/workers/claim/route.ts) and the runner queue read
 * (lib/claim-order-queue.ts, GET /api/workers/queue) both import these.
 * Spec c7410e76 R-26.
 */
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { EXPLICIT_ROLE_SLUGS } from '@buildd/shared';
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

/**
 * A serial lane's stored order (spec: Overlap scheduling, I-3): first come by
 * when the task became claimable apart from the lane (`claimable_since`, never
 * moved once stamped; an entry not yet stamped goes last), then priority, then
 * creation time. The claim route, explain, the probe and the terminal Queue all
 * read lane positions through lib/serial-lanes-store.ts, which orders by this.
 */
export function laneOrderBy(
  e: { claimableSince: any },
  t: typeof tasks,
): SQL[] {
  return [sql`${e.claimableSince} ASC NULLS LAST`, sql`${t.priority} DESC`, sql`${t.createdAt} ASC`, sql`${t.id} ASC`];
}

/** JS mirror of laneOrderBy, for a list already read. Keep the two in step. */
export function compareLaneOrder(
  a: { claimableSince: Date | string | null; priority: number | null; createdAt: Date | string; taskId: string },
  b: { claimableSince: Date | string | null; priority: number | null; createdAt: Date | string; taskId: string },
): number {
  const sa = a.claimableSince == null ? Infinity : new Date(a.claimableSince).getTime();
  const sb = b.claimableSince == null ? Infinity : new Date(b.claimableSince).getTime();
  if (sa !== sb) return sa < sb ? -1 : 1;
  const byClaim = compareClaimOrder(a, b);
  if (byClaim !== 0) return byClaim;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
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

/**
 * Role-slug gate for the claim route.
 *
 * Two rules, applied together:
 *
 *   1. Explicit slugs (EXPLICIT_ROLE_SLUGS, e.g. 'visual-auditor') are opt-in.
 *      A task routed to one is claimable ONLY by a runner that lists that slug
 *      in `availableSkills`. An empty/omitted list no longer matches it.
 *   2. Every other slug keeps the legacy rule: an empty list claims anything,
 *      and a non-empty list of legacy slugs restricts claims to unrouted tasks
 *      plus those slugs.
 *
 * Rule 2 considers only the legacy part of the list, so a browser runner that
 * advertises just ['visual-auditor'] still claims builder/organizer/... tasks.
 * Folding the explicit slug into the old `IS NULL OR IN (list)` clause would
 * have stranded them.
 *
 * Returns clauses to AND into the claim's WHERE. `isRoleClaimable` is the JS
 * mirror; keep the two in step.
 *
 * Slug match only, by design: personal roles share slugs across owners, so a
 * runner advertising a personal slug may pull any task with that slug. Which
 * row the task then runs under is decided per task by who it is for
 * (@buildd/core/role-visibility), so another member's private role is never
 * applied to it — and task creation refuses a slug that names only someone
 * else's private role.
 */
export function roleSlugGate(availableSkills: readonly string[] | undefined): SQL[] {
  const skills = availableSkills ?? [];
  const explicit = skills.filter((s) => EXPLICIT_ROLE_SLUGS.includes(s));
  const legacy = skills.filter((s) => !EXPLICIT_ROLE_SLUGS.includes(s));

  // `IS NULL` is load-bearing: `NULL NOT IN (...)` is NULL, which would drop
  // every unrouted task.
  const clauses: SQL[] = [
    or(
      isNull(tasks.roleSlug),
      notInArray(tasks.roleSlug, [...EXPLICIT_ROLE_SLUGS]),
      ...(explicit.length > 0 ? [inArray(tasks.roleSlug, explicit)] : []),
    )!,
  ];

  if (legacy.length > 0) {
    // Explicit-slug tasks pass here so rule 1 alone decides them.
    clauses.push(
      or(
        isNull(tasks.roleSlug),
        inArray(tasks.roleSlug, [...EXPLICIT_ROLE_SLUGS]),
        inArray(tasks.roleSlug, legacy),
      )!,
    );
  }

  return clauses;
}

/** JS mirror of `roleSlugGate`: could a runner advertising `availableSkills` claim a task with `roleSlug`? */
export function isRoleClaimable(
  roleSlug: string | null | undefined,
  availableSkills: readonly string[] | undefined,
): boolean {
  if (!roleSlug) return true;
  const skills = availableSkills ?? [];
  if (EXPLICIT_ROLE_SLUGS.includes(roleSlug)) return skills.includes(roleSlug);
  const legacy = skills.filter((s) => !EXPLICIT_ROLE_SLUGS.includes(s));
  return legacy.length === 0 || legacy.includes(roleSlug);
}
