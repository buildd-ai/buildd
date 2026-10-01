import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { requestMissionSurfaceAudit } from '@/lib/mission-surface-audit';
import { isUuid } from '@/lib/uuid';
import { workspaceOpenToCaller } from '@/lib/open-workspaces';

/**
 * POST /api/missions/[id]/surface-audit
 *
 * "Run visual audit" on the decision sheet: puts the mission's visual audit on
 * the board. Idempotent: an audit that is already open or done is returned
 * (`created: false`), never duplicated.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid mission id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: { id: true, teamId: true, workspaceId: true },
    });
    const allowed = !!mission && (
      teamIds.includes(mission.teamId)
      || (!!mission.workspaceId && await workspaceOpenToCaller(mission.workspaceId, { teamIds, accountId: apiAccount?.id }))
    );
    if (!mission || !allowed) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });

    const result = await requestMissionSurfaceAudit(id);
    if (!result.ok) {
      const status = result.reason === 'mission_not_found' ? 404 : 409;
      const error = result.reason === 'mission_closed'
        ? 'This mission is already closed, so a visual audit cannot be added.'
        : result.reason === 'no_workspace'
          ? 'This mission has no workspace to run an audit in.'
          : 'Mission not found';
      return NextResponse.json({ error, code: result.reason }, { status });
    }
    return NextResponse.json({ created: result.created, taskId: result.taskId, status: result.status });
  } catch (error) {
    console.error('Request surface audit error:', error);
    return NextResponse.json({ error: 'Failed to request a visual audit' }, { status: 500 });
  }
}
