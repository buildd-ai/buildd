/**
 * Who may decide on a mission's visual review: a signed-in member of the
 * mission's team who reaches its workspace (the GET route's rule, session
 * side). Shared by POST (decide) and DELETE (undo) so the two cannot drift.
 */
import { NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveAccountTeamIds, verifyWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import type { DecisionMission, DecisionReviewer } from '@/lib/visual-review-decisions';

const notFound = () => NextResponse.json({ error: 'Mission not found' }, { status: 404 });

export async function resolveDecisionMission(
  id: string,
): Promise<{ ok: true; mission: DecisionMission; reviewer: DecisionReviewer } | { ok: false; response: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!isUuid(id)) return { ok: false, response: notFound() };

  const teamIds = await resolveAccountTeamIds(user, null);
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, id),
    columns: { id: true, teamId: true, workspaceId: true },
  });
  if (!mission || !teamIds.includes(mission.teamId)) return { ok: false, response: notFound() };
  if (mission.workspaceId && (await verifyWorkspaceAccess(user.id, mission.workspaceId)) === null) {
    return { ok: false, response: notFound() };
  }
  return {
    ok: true,
    mission: { id: mission.id, teamId: mission.teamId, workspaceId: mission.workspaceId },
    reviewer: { userId: user.id, label: user.name || user.email || null },
  };
}
