import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { runMission } from '@/lib/mission-run';
import { db } from '@buildd/core/db';
import { missions, workspaces, missionNotes } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

const resolveTeamIds = resolveAccountTeamIds;

/**
 * POST /api/missions/[id]/run
 *
 * Manually trigger an immediate planning task for a mission.
 * Builds rich mission context (task history, active tasks, failures)
 * and creates + dispatches a planning task.
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

  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const teamIds = await resolveTeamIds(user, apiAccount);

    // Verify mission exists and belongs to user's team (or open-access workspace)
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: { id: true, teamId: true, workspaceId: true, orchestrationMode: true },
    });

    if (!mission) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }
    if (!teamIds.includes(mission.teamId)) {
      // Check if workspace is open-access
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

    const result = await runMission(id, { manualRun: true });

    // Emit audit note for one-shot runs in manual mode (owner-triggered, so actor attribution matters)
    if (mission.orchestrationMode === 'manual' && result.task && !result.deduped) {
      const actor = user ? `user ${user.id}` : 'API key';
      const authorType = user ? 'user' as const : 'system' as const;
      await db.insert(missionNotes).values({
        missionId: id,
        authorType,
        type: 'update',
        title: 'One-shot run triggered',
        body: `Manual orchestration run triggered by ${actor}. Orchestrator will evaluate the mission once then return to idle.`,
        status: 'open',
      }).catch(e => console.error('[run] Failed to emit manual-run note:', e));
    }

    if (result.deduped) {
      return NextResponse.json({ task: result.task, deduped: true }, { status: 200 });
    }
    return NextResponse.json({ task: result.task }, { status: 201 });
  } catch (error: any) {
    if (error.message?.includes('Cannot run mission with status')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Run mission error:', error);
    return NextResponse.json({ error: 'Failed to run mission' }, { status: 500 });
  }
}
