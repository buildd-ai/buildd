/**
 * Which role slugs are effective for one workspace — the per-task resolution
 * docs/design/role-routing.md §3.1 prescribes, the same scoping
 * `checkConnectorRouting` uses: rows of the workspace's team whose
 * `workspaceId` is NULL (team default) or this workspace (override), keyed by
 * slug, the workspace row winning.
 *
 * Used where code sets a role on a task it creates from a slug something else
 * wrote earlier (a plan step, a schedule template). A slug that no longer
 * resolves here names no persona and would strand the task at claim, so the
 * caller files it role-less instead.
 */

import { db } from '@buildd/core/db';
import { workspaces, workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';

export interface RoleScopeRow {
  slug: string;
  workspaceId: string | null;
  enabled: boolean | null;
}

/** Pure: effective slugs from the team-default and override rows of one workspace. */
export function effectiveRoleSlugs(rows: RoleScopeRow[], workspaceId: string): Set<string> {
  const bySlug = new Map<string, RoleScopeRow>();
  for (const row of rows) {
    const seen = bySlug.get(row.slug);
    // The workspace override wins, including an override that disables the role.
    if (!seen || (row.workspaceId === workspaceId && seen.workspaceId !== workspaceId)) {
      bySlug.set(row.slug, row);
    }
  }
  return new Set([...bySlug.values()].filter(r => r.enabled !== false).map(r => r.slug));
}

/** The role slugs a task in `workspaceId` may carry. Empty when the workspace is unknown. */
export async function resolveEffectiveRoleSlugs(workspaceId: string): Promise<Set<string>> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  if (!ws?.teamId) return new Set();

  const rows = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.teamId, ws.teamId),
      eq(workspaceSkills.isRole, true),
      or(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.workspaceId, workspaceId)),
    ),
    columns: { slug: true, workspaceId: true, enabled: true },
  });
  return effectiveRoleSlugs(rows, workspaceId);
}
