// The release that carries THIS mission's work, for the mission's Delivery
// "Shipped" row link. Resolved through `release_tasks` attribution (the same
// task→release edge mission-ship-state reads), so it is never the workspace's
// latest release — a release that shipped after the mission contains none of
// its work. Null when no release carries any of the mission's tasks; the row
// then links to the workspace's releases list.
import { db } from '@buildd/core/db';
import { releases, releaseTasks, tasks } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';

export async function loadMissionCarryingReleaseId(missionId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: releases.id })
    .from(releaseTasks)
    .innerJoin(releases, eq(releases.id, releaseTasks.releaseId))
    .innerJoin(tasks, eq(tasks.id, releaseTasks.taskId))
    .where(eq(tasks.missionId, missionId))
    .orderBy(desc(releases.createdAt))
    .limit(1);
  return row?.id ?? null;
}
