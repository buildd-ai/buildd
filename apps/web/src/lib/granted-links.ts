/**
 * The live re-check on a person-granted `account_workspaces` row (spec "One
 * runner for every team you run", R-3).
 *
 * A row a person picked on the runner consent page carries
 * `granted_by_user_id`. It reaches its workspace only while, right now:
 *   - that person is a member of the workspace's team, and
 *   - the workspace is `open`, or the person is an owner or admin there.
 * Leaving the team, losing the role a restricted workspace needed, or the
 * workspace turning restricted under a member drops it, with no cleanup step.
 *
 * A row without the marker (an admin's link, or any row written before picks
 * existed) is not touched by this: it behaves exactly as it always has (R-6).
 *
 * Subpath imports, not 'drizzle-orm': many route tests mock that module with
 * only the operators they use, and this file is loaded by every route that
 * reads account permissions (account-workspace-cache.ts).
 */
import { sql, type SQL } from 'drizzle-orm/sql/sql';
import { and, eq, isNotNull } from 'drizzle-orm/sql/expressions/conditions';
import { db } from '@buildd/core/db';
import { sqlWhere } from '@buildd/core/db/relational-sql';
// A namespace import: route tests that mock the schema with only the tables
// they use would fail to load this file on a named import of the others.
import * as schema from '@buildd/core/db/schema';

/**
 * True for a granted row whose grant still holds. Written against
 * `account_workspaces` columns, so it composes into any query on that table
 * (including a relational one through sqlWhere, which re-points them).
 */
export function grantedLinkStillValid(): SQL {
  const aw = schema.accountWorkspaces;
  // The subquery names its own tables (`gw`, `gm`), so it cannot capture or be
  // captured by an outer query on workspaces or team_members.
  return sql`exists (select 1 from "workspaces" "gw" inner join "team_members" "gm" on "gm"."team_id" = "gw"."team_id" where "gw"."id" = ${aw.workspaceId} and "gm"."user_id" = ${aw.grantedByUserId} and ("gw"."access_mode" = 'open' or "gm"."role" in ('owner', 'admin')))`;
}

/**
 * The condition every read of `account_workspaces` that decides reach adds:
 * an unmarked row counts as before, a granted row only while it still holds.
 */
export function liveLinkCondition(): SQL {
  return sql`(${schema.accountWorkspaces.grantedByUserId} is null or ${grantedLinkStillValid()})`;
}

/** The query behind liveGrantedWorkspaceIds, exported so its SQL can be pinned. */
export function liveGrantedLinksQuery(accountId: string) {
  const aw = schema.accountWorkspaces;
  return db
    .select({ workspaceId: aw.workspaceId })
    .from(aw)
    .where(and(eq(aw.accountId, accountId), isNotNull(aw.grantedByUserId), grantedLinkStillValid()));
}

/** The workspaces this account's granted rows still reach. Never cached. */
export async function liveGrantedWorkspaceIds(accountId: string): Promise<Set<string>> {
  const rows = await liveGrantedLinksQuery(accountId);
  return new Set(rows.map((r) => r.workspaceId));
}

/** True while the granted row (account, workspace) still holds. One indexed lookup. */
export async function grantedLinkHolds(accountId: string, workspaceId: string): Promise<boolean> {
  const aw = schema.accountWorkspaces;
  const rows = await db
    .select({ workspaceId: aw.workspaceId })
    .from(aw)
    .where(and(eq(aw.accountId, accountId), eq(aw.workspaceId, workspaceId), grantedLinkStillValid()))
    .limit(1);
  return rows.length > 0;
}

/**
 * The link the shared reach rule (workspace-reach.ts) decides with, for one
 * account and workspace: null when there is none, the row as it is when it is
 * an ordinary link, and for a person-granted row whose grant no longer holds,
 * `revoked: true` with no permission. A revoked pick is a deny before any
 * open-mode rule, so a key whose picker left the team cannot fall back to
 * "open within the home team" (spec "One runner for every team you run", R-3).
 */
export async function readReachLink(
  accountId: string,
  workspaceId: string,
): Promise<{ canClaim: boolean; canCreate: boolean; revoked?: boolean } | null> {
  const aw = schema.accountWorkspaces;
  const row = await db.query.accountWorkspaces.findFirst({
    where: sqlWhere(and(eq(aw.accountId, accountId), eq(aw.workspaceId, workspaceId))),
    columns: { canClaim: true, canCreate: true, grantedByUserId: true },
  });
  if (!row) return null;
  if (!row.grantedByUserId) return { canClaim: row.canClaim, canCreate: row.canCreate };
  if (await grantedLinkHolds(accountId, workspaceId)) return { canClaim: row.canClaim, canCreate: row.canCreate };
  return { canClaim: false, canCreate: false, revoked: true };
}
