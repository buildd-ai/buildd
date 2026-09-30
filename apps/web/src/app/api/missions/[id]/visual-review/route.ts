import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
/**
 * GET /api/missions/[id]/visual-review: the mission's VisualReviewModel
 * (docs/design/visual-qa-human-review.md, "Read"): cells with round history,
 * human reviews joined, fix tasks with status, PR and merge, the audit phase
 * and the triage queue.
 *
 * Auth: the dashboard session (which is also how the in-process chat API
 * calls it, as the signed-in user), or an admin-level API key. Access is
 * membership of the mission's team, the mission page's own rule, plus access
 * to the mission's workspace: a session through its team (the download
 * route's rule, so no card lists shots whose images would 403), a key
 * through `verifyAccountWorkspaceAccess`. Anything else is a 404, so another
 * team's mission does not exist for the caller. Images never pass through
 * here: each shot's `src` is the access-checked download route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds, verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import { loadVisualReview } from '@/lib/visual-review-load';
import { isUuid } from '@/lib/uuid';

const notFound = () => NextResponse.json({ error: 'Mission not found' }, { status: 404 });

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = user ? null : await authenticateApiKey(apiKey, req);
  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }
  if (!isUuid(id)) return notFound();

  const teamIds = await resolveAccountTeamIds(user, apiAccount);
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, id),
    columns: { id: true, teamId: true, workspaceId: true },
  });
  if (!mission || !teamIds.includes(mission.teamId)) return notFound();
  if (mission.workspaceId) {
    const reaches = user
      ? (await verifyWorkspaceAccess(user.id, mission.workspaceId)) !== null
      : await verifyAccountWorkspaceAccess(apiAccount!.id, mission.workspaceId);
    if (!reaches) return notFound();
  }

  const model = await loadVisualReview({ id: mission.id, workspaceId: mission.workspaceId });
  return NextResponse.json({ model }, { headers: { 'Cache-Control': 'private, no-store' } });
}
