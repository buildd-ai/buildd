/**
 * GET /api/missions/recent: the missions `buildd top` lists (spec c7410e76
 * R-24). Every open mission of the caller's reachable workspaces, plus those
 * finished in the last 7 days, each with its executor, hold, completion time
 * and stage. GET /api/missions does not fit: it is scoped to the account's own
 * team (a runner serves workspaces of several teams) and carries every task
 * of every mission.
 *
 * The read and what "delivered" means: lib/missions-recent.ts.
 *
 * A runner key or a signed-in user; per-task tokens are not accepted.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';
import { loadMissionStages } from '@/lib/mission-stage-load';
import { loadRecentMissions } from '@/lib/missions-recent';
import type { RecentMission } from '@buildd/shared';

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

    const rows = await loadRecentMissions(workspaceIds);
    const stages = await loadMissionStages(rows.map(r => r.id), workspaceIds);
    const out: RecentMission[] = rows.map(r => ({ ...r, stage: stages.get(r.id) ?? null }));
    return NextResponse.json({ missions: out });
  } catch (err) {
    console.error('[missions/recent] failed:', err);
    return NextResponse.json({ error: 'Failed to load missions' }, { status: 500 });
  }
}
