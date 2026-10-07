import { inArray, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { OPEN_TASK_STATUSES } from '@buildd/shared';
import type { WorkspaceActivity } from './rows';

/**
 * The per-workspace aggregate Settings → Workspaces shows: one grouped select
 * over `tasks` for the whole list, never a query per row.
 *
 * Literal `"tasks"."id"` in the EXISTS, not `${tasks.id}`: a single-table
 * select renders its columns unqualified, and a bare "id" there would bind to
 * the workers row (see api/tasks/audit-fields.ts).
 *
 * Stuck: an open task untouched for 24 hours. Red PRs: a task created in the
 * last 30 days whose PR has failing CI, so a long-abandoned PR does not linger.
 */
export const workspaceActivityFields = {
  workspaceId: tasks.workspaceId,
  lastTaskAt: sql<string | Date | null>`max(${tasks.createdAt})`,
  openTasks: sql<number>`(count(*) filter (where ${inArray(tasks.status, [...OPEN_TASK_STATUSES])}))::int`,
  stuckTasks: sql<number>`(count(*) filter (where ${inArray(tasks.status, [...OPEN_TASK_STATUSES])} and ${tasks.updatedAt} < now() - interval '24 hours'))::int`,
  redPrs: sql<number>`(count(*) filter (where ${tasks.createdAt} > now() - interval '30 days' and exists (
    select 1 from ${workers} w
    where w.task_id = "tasks"."id" and w.pr_lifecycle_status = 'ci_failed' and w.merged_at is null
  )))::int`,
};

export async function loadWorkspaceActivity(workspaceIds: string[]): Promise<Map<string, WorkspaceActivity>> {
  if (workspaceIds.length === 0) return new Map();
  const rows = await db
    .select(workspaceActivityFields)
    .from(tasks)
    .where(inArray(tasks.workspaceId, workspaceIds))
    .groupBy(tasks.workspaceId)
    .catch((e) => {
      console.error('Settings: workspace activity query error:', e);
      return [] as Array<{ workspaceId: string | null } & WorkspaceActivity>;
    });
  return new Map(rows.filter((r) => r.workspaceId).map((r) => [r.workspaceId as string, r]));
}
