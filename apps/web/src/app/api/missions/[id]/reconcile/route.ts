import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { authenticateApiKey } from '@/lib/api-auth';
import { reconcileMissionPrState } from '@/lib/pr-state-reconcile';

/**
 * POST /api/missions/[id]/reconcile
 *
 * Re-derives this mission's PR state from GitHub and writes down the truth.
 * Cheap and idempotent — no agent, no token spend — so the mission page calls
 * it on open. Presence keeps state fresh; the cron still owns the clock.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: { id: true, teamId: true, workspaceId: true },
    });
    if (!mission) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    if (!teamIds.includes(mission.teamId)) {
      let allowed = false;
      if (mission.workspaceId) {
        const ws = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, mission.workspaceId),
          columns: { accessMode: true },
        });
        if (ws?.accessMode === 'open') allowed = true;
      }
      if (!allowed) {
        return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
      }
    }

    const dryRun = req.nextUrl.searchParams.get('dryRun') === 'true';
    const result = await reconcileMissionPrState(id, { dryRun });

    if (result.fixes.length > 0) {
      console.log(
        `[pr-reconcile] mission ${id}: corrected ${result.fixes.length} worker PR state(s)`,
        result.fixes.map((f) => `${f.prUrl} ${f.before.prLifecycleStatus} → ${f.after.prLifecycleStatus}`),
      );
    }

    return NextResponse.json({
      checked: result.checked,
      corrected: result.fixes.length,
      fixes: result.fixes,
      unverified: result.unverified,
      dryRun,
    });
  } catch (error) {
    console.error('Reconcile mission PR state error:', error);
    return NextResponse.json({ error: 'Failed to reconcile' }, { status: 500 });
  }
}
