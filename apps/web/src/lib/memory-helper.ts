/**
 * Memory store resolution for MCP routes and server components.
 * Used by both /api/mcp (API-key auth) and /api/mcp-oauth (JWT auth).
 *
 * Resolves workspace → team and returns a MemoryStore, or null when teamId
 * cannot be resolved. No external service — queries the local memories table.
 */
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { MemoryStore } from '@buildd/core/memory-store';

export async function getMemoryStoreForTeam(
  workspaceId: string | null | undefined,
  fallbackTeamId?: string,
): Promise<MemoryStore | null> {
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

  return new MemoryStore(teamId);
}

/** @deprecated Use getMemoryStoreForTeam */
export const getMemoryClientForTeam = getMemoryStoreForTeam;
