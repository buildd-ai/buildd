import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { releases, releaseTasks, tasks } from '@buildd/core/db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { verifyWorkspaceAccess } from '@/lib/team-access';

/**
 * GET /api/releases?workspaceId=<id>
 * List all releases for a workspace with task/mission counts
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

  const teamIds = await getUserTeamIds(user.id);
  await verifyWorkspaceAccess(workspaceId, teamIds);

  const releaseRows = await db
    .select({
      id: releases.id,
      archetype: releases.archetype,
      state: releases.state,
      dispatchedAt: releases.dispatchedAt,
      deployedAt: releases.deployedAt,
      healthyAt: releases.healthyAt,
      commitsAheadAtDispatch: releases.commitsAheadAtDispatch,
      createdAt: releases.createdAt,
      version: releases.version,
      previousSha: releases.previousSha,
      headSha: releases.headSha,
      triggeredBy: releases.triggeredBy,
    })
    .from(releases)
    .where(eq(releases.workspaceId, workspaceId))
    .orderBy(desc(releases.createdAt));

  // Load task and mission counts per release
  const releaseTaskCounts = await db
    .select({
      releaseId: releaseTasks.releaseId,
      taskCount: sql<number>`count(distinct ${releaseTasks.taskId})::int`,
      missionCount: sql<number>`count(distinct ${tasks.missionId})::int`,
    })
    .from(releaseTasks)
    .leftJoin(tasks, eq(releaseTasks.taskId, tasks.id))
    .groupBy(releaseTasks.releaseId);

  const countMap = new Map<string, { taskCount: number; missionCount: number }>();
  releaseTaskCounts.forEach((row) => {
    countMap.set(row.releaseId, {
      taskCount: row.taskCount,
      missionCount: row.missionCount,
    });
  });

  const enriched = releaseRows.map((r) => ({
    ...r,
    taskCount: countMap.get(r.id)?.taskCount ?? 0,
    missionCount: countMap.get(r.id)?.missionCount ?? 0,
  }));

  return NextResponse.json({ releases: enriched });
}
