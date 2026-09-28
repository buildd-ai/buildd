/**
 * Resolves the memory project key a workspace is allowed to use. See
 * `memoryProjectKey` in ./project-scope for the rule; this is the DB lookup.
 */
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { workspaces } from './db/schema';
import { memoryProjectKey } from './project-scope';

/**
 * The workspace's memory project key, or null when it must get no memory:
 * unknown workspace, sensitive workspace, no key, a key shared with a
 * sensitive workspace in the same team, or a failed lookup (fail closed).
 */
export async function resolveMemoryProjectKey(
  workspaceId: string | null | undefined,
): Promise<string | null> {
  if (!workspaceId) return null;
  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { id: true, teamId: true, repo: true, name: true, dataClass: true },
    });
    if (!ws) return null;
    const sensitive = await db.query.workspaces.findMany({
      where: and(eq(workspaces.teamId, ws.teamId), eq(workspaces.dataClass, 'sensitive')),
      columns: { id: true, repo: true, name: true, dataClass: true },
    });
    return memoryProjectKey(ws, sensitive);
  } catch {
    return null;
  }
}
