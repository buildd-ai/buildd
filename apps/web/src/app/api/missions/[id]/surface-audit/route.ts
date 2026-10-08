import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { requestMissionSurfaceAudit } from '@/lib/mission-surface-audit';
import { previewMissionSurfaceAudit } from '@/lib/mission-surface-audit-preview';
import { isUuid } from '@/lib/uuid';
import { workspaceOpenToCaller } from '@/lib/open-workspaces';

type Params = { params: Promise<{ id: string }> };

/** The caller may act on this mission: a NextResponse refusal, or null to go on. */
async function refuse(req: NextRequest, id: string): Promise<NextResponse | null> {
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
  return null;
}

function planRefusal(reason: 'mission_not_found' | 'mission_closed' | 'no_workspace') {
  const status = reason === 'mission_not_found' ? 404 : 409;
  const error = reason === 'mission_closed'
    ? 'This mission is already closed, so a visual review cannot be added.'
    : reason === 'no_workspace'
      ? 'This mission has no workspace to run a visual review in.'
      : 'Mission not found';
  return NextResponse.json({ error, code: reason }, { status });
}

/**
 * GET /api/missions/[id]/surface-audit
 *
 * What "Run visual review" would do, without doing it: the existing audit, or
 * the screens, viewports, capture source and browser-runner availability of a
 * new one. The mission page's Visual review sheet shows it before the person
 * confirms.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const denied = await refuse(req, id);
    if (denied) return denied;
    const result = await previewMissionSurfaceAudit(id);
    if (!result.ok) return planRefusal(result.reason);
    return NextResponse.json({ preview: result.preview });
  } catch (error) {
    console.error('Preview surface audit error:', error);
    return NextResponse.json({ error: 'Failed to read the visual review plan' }, { status: 500 });
  }
}

/**
 * POST /api/missions/[id]/surface-audit
 *
 * A person asked for the mission's visual review: the decision sheet's "Run
 * visual audit" and the mission header's "Run visual review" (both through
 * lib/mission-visual-review-request.ts). Idempotent: an audit that is already
 * open or done is returned (`created: false`), never duplicated.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const denied = await refuse(req, id);
    if (denied) return denied;

    const result = await requestMissionSurfaceAudit(id);
    if (!result.ok) return planRefusal(result.reason);
    return NextResponse.json({ created: result.created, taskId: result.taskId, status: result.status });
  } catch (error) {
    console.error('Request surface audit error:', error);
    return NextResponse.json({ error: 'Failed to request a visual audit' }, { status: 500 });
  }
}
