/**
 * "All current and future workspaces I can reach" on a runner key
 * (accounts.reach_all_workspaces): the workspaces of every team the key's
 * creator belongs to, read at claim time so a new workspace is claimable at
 * once and a person who leaves a team takes their key's reach with them.
 *
 * Reach follows the same rule as a picked workspace (lib/granted-links.ts): an
 * open workspace of a team the person belongs to, or any workspace of a team
 * where they are owner or admin. System workspaces (`__` prefix) are left out,
 * as for an MCP whole-team grant.
 */
import { db } from '@buildd/core/db';
import { teamMembers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, or, sql } from 'drizzle-orm';

export async function reachAllWorkspaceIds(userId: string, workspaceId?: string | null): Promise<string[]> {
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .innerJoin(teamMembers, and(eq(teamMembers.teamId, workspaces.teamId), eq(teamMembers.userId, userId)))
    .where(and(
      or(eq(workspaces.accessMode, 'open'), inArray(teamMembers.role, ['owner', 'admin'])),
      workspaceId ? eq(workspaces.id, workspaceId) : undefined,
      sql`${workspaces.name} not like '\\_\\_%'`,
    ));
  return [...new Set(rows.map((r) => r.id))];
}
