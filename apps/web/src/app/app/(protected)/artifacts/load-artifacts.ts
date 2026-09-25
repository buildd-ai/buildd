import { db } from '@buildd/core/db';
import { workspaces, artifacts, workers, tasks } from '@buildd/core/db/schema';
import { and, count, desc, inArray, sql } from 'drizzle-orm';
import { isSystemWorkspace } from '@buildd/shared';
import { reviewArtifactScope, workspaceArtifactScope } from '@/lib/artifact-scope';

/** Rows per "show more" step on /app/artifacts. */
export const ARTIFACTS_PAGE_SIZE = 100;
/** Hard ceiling, so `?limit=` in the URL cannot unbound the query again. */
export const ARTIFACTS_MAX_LIMIT = 1000;

export function parseArtifactLimit(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return ARTIFACTS_PAGE_SIZE;
  return Math.min(n, ARTIFACTS_MAX_LIMIT);
}

/**
 * Which rows the page lists. `review` is the default view, and it is applied
 * in SQL: filtering a loaded page on the client would leave the review view
 * empty whenever the newest rows happen to be byproducts.
 */
export type ArtifactScope = 'review' | 'all';

export function parseArtifactScope(raw: string | string[] | undefined): ArtifactScope {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'all' ? 'all' : 'review';
}

export interface ArtifactPageItem {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  shareToken: string | null;
  visibility: 'private' | 'public';
  metadata: Record<string, unknown>;
  createdAt: string;
  taskTitle: string | null;
  taskId: string | null;
  workspaceName: string | null;
  key: string | null;
  missionId: string | null;
  initiativeId: string | null;
  storageKey: string | null;
}

export interface ArtifactsPage {
  items: ArtifactPageItem[];
  /** Every visible artifact, counted in SQL (not just the loaded page). */
  total: number;
  /** Review-worthy artifacts among `total`, counted in SQL. */
  reviewCount: number;
  /** More rows exist in the current scope beyond the loaded page. */
  hasMore: boolean;
  workspaceCount: number;
}

/**
 * Newest `limit` artifacts visible to a user with access to `wsIds`, plus the
 * worker/task/workspace labels for just those rows.
 *
 * Every query is bounded by the page, not by history: the artifact query has
 * a LIMIT, and worker/task lookups are keyed on ids from the returned rows.
 * The previous version loaded every artifact with full content and every
 * worker the workspaces had ever run.
 */
export async function loadArtifactsPage(
  wsIds: string[],
  limit: number,
  listScope: ArtifactScope = 'all',
): Promise<ArtifactsPage> {
  const scope = workspaceArtifactScope(wsIds);
  // Tenancy first, then the review predicate — `and` keeps the tenancy arms
  // intact so the review filter can only narrow, never widen.
  const listWhere = listScope === 'review' ? and(scope, reviewArtifactScope())! : scope;

  const [userWorkspaces, rows, counts] = await Promise.all([
    db.query.workspaces.findMany({
      where: inArray(workspaces.id, wsIds),
      columns: { id: true, name: true },
    }),
    // One sentinel row past the page tells us whether there is more.
    db.query.artifacts.findMany({
      where: listWhere,
      orderBy: desc(artifacts.createdAt),
      limit: limit + 1,
    }),
    db
      .select({
        total: count(),
        review: sql<number>`count(*) filter (where ${reviewArtifactScope()})`.mapWith(Number),
      })
      .from(artifacts)
      .where(scope),
  ]);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const wsNameMap = new Map(userWorkspaces.map(w => [w.id, w.name]));

  const workerIds = [...new Set(pageRows.map(a => a.workerId).filter((id): id is string => !!id))];
  const workerMeta = new Map<string, { taskId: string | null; workspaceId: string }>();
  if (workerIds.length > 0) {
    const workerRows = await db.query.workers.findMany({
      where: inArray(workers.id, workerIds),
      columns: { id: true, taskId: true, workspaceId: true },
    });
    for (const w of workerRows) workerMeta.set(w.id, { taskId: w.taskId, workspaceId: w.workspaceId });
  }

  const taskIds = [...new Set([...workerMeta.values()].map(m => m.taskId).filter((id): id is string => !!id))];
  const taskMap = new Map<string, { id: string; title: string }>();
  if (taskIds.length > 0) {
    const taskRows = await db.query.tasks.findMany({
      where: inArray(tasks.id, taskIds),
      columns: { id: true, title: true },
    });
    for (const t of taskRows) taskMap.set(t.id, t);
  }

  const items = pageRows.map((a): ArtifactPageItem => {
    const meta = a.workerId ? workerMeta.get(a.workerId) : undefined;
    const task = meta?.taskId ? taskMap.get(meta.taskId) : null;
    // A non-worker artifact carries its own workspace; fall back to the
    // worker's for legacy rows that never had workspace_id set.
    const workspaceId = a.workspaceId || meta?.workspaceId || null;
    return {
      id: a.id,
      type: a.type,
      title: a.title,
      content: a.content,
      shareToken: a.shareToken,
      visibility: (a.visibility as 'private' | 'public') ?? 'private',
      metadata: (a.metadata || {}) as Record<string, unknown>,
      createdAt: a.createdAt.toISOString(),
      taskTitle: task?.title || null,
      taskId: task?.id || null,
      workspaceName: workspaceId ? wsNameMap.get(workspaceId) || null : null,
      // Prominence signals — the client re-applies `isReviewArtifact` so the
      // scope toggle and this page agree by construction.
      key: a.key,
      missionId: a.missionId,
      initiativeId: a.initiativeId,
      storageKey: a.storageKey,
    };
  });

  const countRow = counts[0];
  return {
    items,
    total: Number(countRow?.total ?? 0),
    reviewCount: Number(countRow?.review ?? 0),
    hasMore,
    workspaceCount: userWorkspaces.filter(ws => !isSystemWorkspace(ws.name)).length,
  };
}
