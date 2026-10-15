/**
 * GET /api/missions/recent: the missions `buildd top` lists (spec c7410e76
 * R-24). Every open mission of the caller's reachable workspaces, plus those
 * finished in the last 7 days, each with its executor, hold, completion time
 * and stage. GET /api/missions does not fit: it is scoped to the account's own
 * team (a runner serves workspaces of several teams) and carries every task
 * of every mission.
 *
 * A runner key or a signed-in user; per-task tokens are not accepted.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { and, desc, gte, inArray, or } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';
import { loadMissionStages } from '@/lib/mission-stage-load';
import type { RecentMission } from '@buildd/shared';

export const RECENT_DAYS = 7;
/** A bound on the read; no team keeps this many missions open or finishing in a week. */
const MAX_MISSIONS = 300;
const OPEN_STATUSES = ['active', 'paused', 'budget_exhausted'] as const;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  const user = apiAccount ? null : await getCurrentUser();
  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const workspaceIds = await listReachableWorkspaceIds(apiAccount ? { account: apiAccount } : { userId: user!.id });
    if (workspaceIds.length === 0) return NextResponse.json({ missions: [] });

    const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
    const rows = await db.query.missions.findMany({
      where: sqlWhere(and(
        inArray(missions.workspaceId, workspaceIds),
        or(
          inArray(missions.status, [...OPEN_STATUSES]),
          and(inArray(missions.status, ['completed']), gte(missions.completedAt, since)),
        ),
      )),
      columns: { id: true, title: true, workspaceId: true, status: true, isHeld: true, executor: true, completedAt: true, updatedAt: true },
      orderBy: sqlOrderBy([desc(missions.updatedAt)]),
      limit: MAX_MISSIONS,
    });

    const stages = await loadMissionStages(rows.map(r => r.id), workspaceIds);
    const out: RecentMission[] = rows.map(r => ({
      id: r.id,
      title: r.title,
      workspaceId: r.workspaceId as string,
      status: r.status,
      isHeld: !!r.isHeld,
      executor: r.executor,
      completedAt: r.status === 'completed' ? (r.completedAt ?? r.updatedAt)?.toISOString() ?? null : null,
      stage: stages.get(r.id) ?? null,
    }));
    return NextResponse.json({ missions: out });
  } catch (err) {
    console.error('[missions/recent] failed:', err);
    return NextResponse.json({ error: 'Failed to load missions' }, { status: 500 });
  }
}
