import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

/**
 * The task's role row (name, colour) — a workspace-scoped role wins over the
 * team-wide one with the same slug, the same scoping the mission planner uses
 * (lib/mission-context.ts). Never a hardcoded role map: names and colours are
 * workspace data.
 */
export async function findTaskRole(opts: { workspaceId: string; teamId: string | null | undefined; slug: string | null | undefined }) {
  if (!opts.slug) return null;
  const scope = opts.teamId
    ? or(eq(workspaceSkills.workspaceId, opts.workspaceId), and(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.teamId, opts.teamId)))
    : eq(workspaceSkills.workspaceId, opts.workspaceId);
  const row = await db.query.workspaceSkills.findFirst({
    where: and(scope, eq(workspaceSkills.slug, opts.slug), eq(workspaceSkills.isRole, true)),
    columns: { name: true, color: true },
    orderBy: sql`${workspaceSkills.workspaceId} is null`,
  });
  return row ?? null;
}
