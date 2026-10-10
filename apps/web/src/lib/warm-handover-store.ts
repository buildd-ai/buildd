import { db } from '@buildd/core/db';
import { teams } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { resolveWarmHandover } from '@buildd/shared';
export async function resolveWorkspaceWarmHandover(workspace: { teamId?: string; gitConfig?: unknown }) {
  const team = workspace.teamId ? await db.query.teams.findFirst({
    where: eq(teams.id, workspace.teamId), columns: { warmHandover: true },
  }) : null;
  return resolveWarmHandover(team?.warmHandover, (workspace.gitConfig as { warmHandover?: unknown } | null)?.warmHandover);
}
