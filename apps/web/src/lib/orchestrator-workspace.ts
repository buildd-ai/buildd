import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';

const COORDINATION_WORKSPACE_NAME = '__coordination';

/**
 * Get or create the coordination workspace for a team.
 * Used for tasks that don't belong to a specific codebase — missions,
 * finance, research, or any role that coordinates work without needing
 * git config or a repo.
 */
export async function getOrCreateCoordinationWorkspace(teamId: string): Promise<{ id: string }> {
  const existing = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.name, COORDINATION_WORKSPACE_NAME), eq(workspaces.teamId, teamId)),
    columns: { id: true },
  });

  if (existing) return existing;

  const [created] = await db
    .insert(workspaces)
    .values({
      name: COORDINATION_WORKSPACE_NAME,
      teamId,
      accessMode: 'open',
    })
    .returning({ id: workspaces.id });

  return created;
}
