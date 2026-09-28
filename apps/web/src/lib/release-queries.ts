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
import { githubRepos, missions, releases, releaseTasks, tasks, workspaces } from '@buildd/core/db/schema';
import { and, eq, gte, inArray, desc } from 'drizzle-orm';

export interface ListReleasesParams {
  workspaceId: string;
  missionId?: string;
  state?: string;
  /** Clamped to [1, 50]; defaults to 10. */
  limit?: number;
  /** Only releases created in the last N days. */
  sinceDays?: number;
  /** Attach each release's shipped tasks (title, PR), from one extra query. */
  withTasks?: boolean;
}

export interface ReleaseShippedTask {
  taskId: string | null;
  title: string | null;
  prNumber: number | null;
  label: string | null;
  category: string | null;
  missionId: string | null;
  missionTitle: string | null;
}

export async function listReleasesQuery(params: ListReleasesParams) {
  const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 10)), 50);

  const conditions: Parameters<typeof and>[0][] = [eq(releases.workspaceId, params.workspaceId)];
  if (params.state) {
    conditions.push(eq(releases.state, params.state as 'dispatched' | 'deploying' | 'healthy' | 'failed' | 'degraded' | 'pending_external'));
  }
  if (params.sinceDays && params.sinceDays > 0) {
    conditions.push(gte(releases.createdAt, new Date(Date.now() - params.sinceDays * 86_400_000)));
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

  const rows = await db
    .select()
    .from(releases)
    .where(and(...conditions))
    .orderBy(desc(releases.createdAt))
    .limit(limit);
  if (!params.withTasks || rows.length === 0) return rows;

  const [edges, [repoRow]] = await Promise.all([
    db
      .select({
        releaseId: releaseTasks.releaseId, taskId: releaseTasks.taskId, prNumber: releaseTasks.prNumber,
        title: tasks.title, label: tasks.label, category: tasks.category, missionId: tasks.missionId, missionTitle: missions.title,
      })
      .from(releaseTasks)
      .leftJoin(tasks, eq(releaseTasks.taskId, tasks.id))
      .leftJoin(missions, eq(tasks.missionId, missions.id))
      .where(inArray(releaseTasks.releaseId, rows.map(r => r.id))),
    // The repo the PR numbers belong to, so a reader can link and group them.
    db
      .select({ fullName: githubRepos.fullName })
      .from(workspaces)
      .innerJoin(githubRepos, eq(workspaces.githubRepoId, githubRepos.id))
      .where(eq(workspaces.id, params.workspaceId))
      .limit(1),
  ]);
  const byRelease = new Map<string, ReleaseShippedTask[]>();
  for (const { releaseId, ...e } of edges) {
    const list = byRelease.get(releaseId) ?? [];
    list.push(e);
    byRelease.set(releaseId, list);
  }
  const repo = repoRow?.fullName ?? null;
  return rows.map(r => ({ ...r, repo, tasks: byRelease.get(r.id) ?? [] }));
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
