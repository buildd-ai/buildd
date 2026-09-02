/**
 * Shared DB query logic for release reads.
 *
 * Single source of truth for "list releases for a workspace/mission" and
 * "fetch a release with its task edges" — used by both the release REST
 * routes (apps/web/src/app/api/releases/**) and the MCP `list_releases` /
 * `get_release` inline handler in apps/web/src/app/api/mcp/route.ts. Keeping
 * one implementation avoids the two DB queries silently drifting, which is
 * how list_releases/get_release ended up with no handler reachable from the
 * OAuth MCP transport (see mcp-tools.ts handleBuilddAction cases).
 */
import { db } from '@buildd/core/db';
import { releases, releaseTasks, tasks } from '@buildd/core/db/schema';
import { and, eq, inArray, desc } from 'drizzle-orm';

export interface ListReleasesParams {
  workspaceId: string;
  missionId?: string;
  state?: string;
  /** Clamped to [1, 50]; defaults to 10. */
  limit?: number;
}

export async function listReleasesQuery(params: ListReleasesParams) {
  const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 10)), 50);

  const conditions: Parameters<typeof and>[0][] = [eq(releases.workspaceId, params.workspaceId)];
  if (params.state) {
    conditions.push(eq(releases.state, params.state as 'dispatched' | 'deploying' | 'healthy' | 'failed' | 'degraded' | 'pending_external'));
  }

  if (params.missionId) {
    const taskRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.missionId, params.missionId));
    const taskIds = taskRows.map((t) => t.id);
    if (taskIds.length === 0) return [];

    const edgeRows = await db
      .select({ releaseId: releaseTasks.releaseId })
      .from(releaseTasks)
      .where(inArray(releaseTasks.taskId, taskIds));
    const releaseIds = [...new Set(edgeRows.map((r) => r.releaseId))];
    if (releaseIds.length === 0) return [];

    conditions.push(inArray(releases.id, releaseIds));
  }

  return db
    .select()
    .from(releases)
    .where(and(...conditions))
    .orderBy(desc(releases.createdAt))
    .limit(limit);
}

export interface ReleaseTaskEdge {
  taskId: string | null;
  prNumber: number | null;
  commitSha: string | null;
  taskTitle: string | null;
  taskStatus: string | null;
  missionId: string | null;
}

/** Fetches a release row plus its attributed task edges. Returns null if the release doesn't exist. */
export async function getReleaseWithTaskEdges(releaseId: string) {
  const release = await db.query.releases.findFirst({
    where: eq(releases.id, releaseId),
  });
  if (!release) return null;

  const edges: ReleaseTaskEdge[] = await db
    .select({
      taskId: releaseTasks.taskId,
      prNumber: releaseTasks.prNumber,
      commitSha: releaseTasks.commitSha,
      taskTitle: tasks.title,
      taskStatus: tasks.status,
      missionId: tasks.missionId,
    })
    .from(releaseTasks)
    .leftJoin(tasks, eq(releaseTasks.taskId, tasks.id))
    .where(eq(releaseTasks.releaseId, releaseId));

  return { release, edges };
}
