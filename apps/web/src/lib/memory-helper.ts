/**
 * Shared memory client resolution for MCP routes.
 * Used by both /api/mcp (API-key auth) and /api/mcp-oauth (JWT auth).
 *
 * Resolves the team's memory key (auto-provisioning if needed) and returns
 * a configured MemoryClient, or null when the memory service isn't set up.
 */
import { db } from '@buildd/core/db';
import { teams, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { MemoryClient } from '@buildd/core/memory-client';

export async function getMemoryClientForTeam(
  workspaceId: string | null | undefined,
  fallbackTeamId?: string,
): Promise<MemoryClient | null> {
  const url = process.env.MEMORY_API_URL;
  if (!url) return null;

  let teamId: string | undefined;
  if (workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { teamId: true },
    });
    teamId = ws?.teamId;
  }
  if (!teamId && fallbackTeamId) {
    teamId = fallbackTeamId;
  }
  if (!teamId) return null;

  const team = await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    columns: { id: true, memoryApiKey: true },
  });
  if (!team) return null;

  if (team.memoryApiKey) {
    return new MemoryClient(url, team.memoryApiKey);
  }

  // Auto-provision a memory key for this team.
  const rootKey = process.env.MEMORY_ROOT_KEY;
  if (!rootKey) return null;
  try {
    const res = await fetch(`${url}/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rootKey}` },
      body: JSON.stringify({ teamId: team.id, name: 'buildd-auto' }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const newKey = data.key as string;
    await db.update(teams).set({ memoryApiKey: newKey }).where(eq(teams.id, team.id));
    return new MemoryClient(url, newKey);
  } catch (err) {
    console.error('Failed to auto-provision memory key:', err);
    return null;
  }
}
