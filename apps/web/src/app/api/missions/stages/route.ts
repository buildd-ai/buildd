/**
 * GET /api/missions/stages?ids=<uuid>,<uuid> — each named mission's stage
 * (spec c7410e76 R-18): the Build / Verify / Deliver rail's current step and
 * what it waits on, from the rail's own projection (lib/mission-stage.ts).
 *
 * `buildd top` asks for the missions its task list shows. This lives with the
 * missions module rather than on GET /api/tasks so core never imports the
 * mission projection (scripts/module-boundaries.test.ts).
 *
 * Scoped to the caller's reachable workspaces: a mission in another workspace,
 * or an unknown id, is simply absent from `stages`. A runner key or a signed-in
 * user; per-task tokens are not accepted.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';
import { loadMissionStages } from '@/lib/mission-stage-load';
import { isUuid } from '@/lib/uuid';
import type { MissionStage } from '@buildd/shared';

/** The task list holds at most 200 tasks, so far fewer missions; the cap bounds the batched reads. */
const MAX_MISSION_IDS = 100;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  const user = apiAccount ? null : await getCurrentUser();
  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = req.nextUrl.searchParams.get('ids') ?? '';
  const ids = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
  const bad = ids.find(id => !isUuid(id));
  if (bad !== undefined) {
    return NextResponse.json({ error: `ids must be full mission UUIDs — received "${bad}".` }, { status: 400 });
  }
  if (ids.length > MAX_MISSION_IDS) {
    return NextResponse.json({ error: `At most ${MAX_MISSION_IDS} mission ids per request — received ${ids.length}.` }, { status: 400 });
  }
  if (ids.length === 0) return NextResponse.json({ stages: {} });

  try {
    const workspaceIds = await listReachableWorkspaceIds(apiAccount ? { account: apiAccount } : { userId: user!.id });
    const stages = await loadMissionStages(ids, workspaceIds);
    const out: Record<string, MissionStage> = {};
    for (const [id, stage] of stages) out[id] = stage;
    return NextResponse.json({ stages: out });
  } catch (err) {
    console.error('[missions/stages] failed:', err);
    return NextResponse.json({ error: 'Failed to load mission stages' }, { status: 500 });
  }
}
