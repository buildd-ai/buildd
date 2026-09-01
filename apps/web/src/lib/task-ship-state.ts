// The ONE shared resolver for "is this task attributed to a healthy release".
// Every surface that mounts TaskShipBadge (TaskCard, task detail page) must
// call this instead of re-deriving the release_tasks join locally — see
// docs/specs/surface-ia-home-missions-initiatives.md §10.3.
import { db } from '@buildd/core/db';
import { releaseTasks, releases } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';

export type ShippedRelease = { releaseId: string } | null;

export async function resolveShippedRelease(taskId: string): Promise<ShippedRelease> {
  const [row] = await db
    .select({ releaseId: releaseTasks.releaseId })
    .from(releaseTasks)
    .innerJoin(releases, eq(releaseTasks.releaseId, releases.id))
    .where(and(eq(releaseTasks.taskId, taskId), eq(releases.state, 'healthy')))
    .limit(1);
  return row ? { releaseId: row.releaseId } : null;
}
