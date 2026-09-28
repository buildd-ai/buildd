/**
 * Resolves the memory project key a workspace is allowed to use. See
 * `memoryProjectKey` in ./project-scope for the rule; this is the DB lookup.
 */
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { workspaces } from './db/schema';
import { memoryProjectKey } from './project-scope';
import { MemoryStore } from './memory-store';
import type { MemoryHitScope } from './memory-hit-scope';

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

/**
 * The scope a server-side memory read (claim-time, planning, authoring prior
 * work) runs under for `workspaceId` in `teamId`: that workspace's project key
 * and a row lookup bound to the same team. `project` is null (no memory) when
 * the key cannot be resolved, or when the workspace is not in `teamId`, since
 * the namespace being narrowed is that team's.
 */
export async function resolveMemoryHitScope(
  workspaceId: string | null | undefined,
  teamId: string | null | undefined,
): Promise<MemoryHitScope | null> {
  if (!workspaceId || !teamId) return null;
  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { id: true, teamId: true, repo: true, name: true, dataClass: true },
    });
    if (!ws || ws.teamId !== teamId) return null;
    const sensitive = await db.query.workspaces.findMany({
      where: and(eq(workspaces.teamId, ws.teamId), eq(workspaces.dataClass, 'sensitive')),
      columns: { id: true, repo: true, name: true, dataClass: true },
    });
    const project = memoryProjectKey(ws, sensitive);
    if (!project) return null;
    const store = new MemoryStore(teamId);
    return {
      project,
      lookup: (ids) => store.batch(ids),
      count: async () => (await store.search({ project, limit: 1 })).total,
    };
  } catch {
    return null;
  }
}
