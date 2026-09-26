/**
 * Role slug → colour for a team, read from the roles themselves
 * (`workspace_skills.color`), never hardcoded in a component.
 *
 * Roles live at two scopes: team-level (workspaceId NULL — the default shape
 * new workspaces get) and workspace-scoped overrides. Both count; an override
 * wins, so those rows sort first and the first colour per slug is kept.
 */
import { db } from '@buildd/core/db';
import { workspaceSkills, workspaces } from '@buildd/core/db/schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

export function teamRolesWhere(teamId: string) {
  return and(
    or(eq(workspaces.teamId, teamId), and(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.teamId, teamId))),
    eq(workspaceSkills.isRole, true),
    eq(workspaceSkills.enabled, true),
  );
}

export async function loadTeamRoleColors(teamId: string): Promise<Map<string, string | null>> {
  const rows = await db
    .select({ slug: workspaceSkills.slug, color: workspaceSkills.color })
    .from(workspaceSkills)
    .leftJoin(workspaces, eq(workspaceSkills.workspaceId, workspaces.id))
    .where(teamRolesWhere(teamId))
    .orderBy(sql`${workspaceSkills.workspaceId} nulls last`);
  const out = new Map<string, string | null>();
  for (const r of rows) if (!out.has(r.slug)) out.set(r.slug, r.color ?? null);
  return out;
}
