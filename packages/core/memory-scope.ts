/**
 * Resolves the memory project key a workspace is allowed to use. See
 * `memoryProjectKey` in ./project-scope for the rule; this is the DB lookup.
 */
import { and, eq, or, type SQL } from 'drizzle-orm';
import { db } from './db';
import { workspaces } from './db/schema';
import { memoryProjectKey } from './project-scope';
import { MemoryStore } from './memory-store';
import type { MemoryHitScope } from './memory-hit-scope';

type ScopeRow = { id: string; teamId: string; repo: string | null; name: string; dataClass: string | null };

const SCOPE_COLUMNS = { id: true, teamId: true, repo: true, name: true, dataClass: true } as const;

/**
 * The rows a memory scope decision needs, in ONE query: the workspace itself,
 * plus every sensitive workspace in its team (a key shared with one of those
 * gets no memory). This used to be two sequential round trips on the claim
 * path, the second waiting on the first only to learn the team id.
 *
 * The team is the one the caller is reading memory for, so sensitive rows come
 * only from that team. The caller still checks that the workspace itself is in
 * it before trusting anything.
 */
export function memoryScopeWorkspacesWhere(workspaceId: string, teamId: string): SQL {
  return or(
    eq(workspaces.id, workspaceId),
    and(eq(workspaces.teamId, teamId), eq(workspaces.dataClass, 'sensitive')),
  )!;
}

/** Split the combined rows into the workspace and its team's sensitive set. */
function splitScopeRows(rows: ScopeRow[], workspaceId: string): { ws: ScopeRow | null; sensitive: ScopeRow[] } {
  const ws = rows.find(r => r.id === workspaceId) ?? null;
  if (!ws) return { ws: null, sensitive: [] };
  const sensitive = rows.filter(r => r.teamId === ws.teamId && r.dataClass === 'sensitive');
  return { ws, sensitive };
}

async function loadScopeRows(workspaceId: string, teamId: string): Promise<ScopeRow[]> {
  return (await db.query.workspaces.findMany({
    where: memoryScopeWorkspacesWhere(workspaceId, teamId),
    columns: SCOPE_COLUMNS,
  })) as ScopeRow[];
}

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
    // Two lookups here, unlike resolveMemoryHitScope below: this runs once per
    // MCP connection, not per claimed task, so it is not on the claim path.
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: SCOPE_COLUMNS,
    });
    if (!ws) return null;
    const sensitive = await db.query.workspaces.findMany({
      where: and(eq(workspaces.teamId, ws.teamId), eq(workspaces.dataClass, 'sensitive')),
      columns: SCOPE_COLUMNS,
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
    const { ws, sensitive } = splitScopeRows(await loadScopeRows(workspaceId, teamId), workspaceId);
    if (!ws || ws.teamId !== teamId) return null;
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
