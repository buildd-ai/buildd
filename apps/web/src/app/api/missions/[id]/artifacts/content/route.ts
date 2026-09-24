import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, artifacts, workspaces, workers, tasks } from '@buildd/core/db/schema';
import { and, eq, inArray, or } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { parseContentIds } from '@/lib/mission-records-content';

/**
 * GET /api/missions/[id]/artifacts/content?ids=a,b — artifact bodies for the
 * mission Records sheet, fetched on open (docs/design/mission-feed-mobile-continuity.md,
 * slice S7, AC-18). The mission page selects artifact metadata only.
 *
 * Scoped to the mission: an artifact is returned only when it is linked to this
 * mission directly or was produced by a worker on one of this mission's tasks.
 * Auth and access mirror `GET /api/missions/[id]/artifacts`.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  const user = await getCurrentUser();
  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
      allowed = ws?.accessMode === 'open';
    }
    if (!allowed) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }
  }

  const ids = parseContentIds(req.nextUrl.searchParams.get('ids'));
  if (ids.length === 0) return NextResponse.json({ contents: {} });

  const rows = await db
    .select({ id: artifacts.id, content: artifacts.content })
    .from(artifacts)
    .leftJoin(workers, eq(artifacts.workerId, workers.id))
    .leftJoin(tasks, eq(workers.taskId, tasks.id))
    .where(and(
      inArray(artifacts.id, ids),
      or(eq(artifacts.missionId, id), eq(tasks.missionId, id)),
    ));

  const contents: Record<string, string | null> = {};
  for (const r of rows) contents[r.id] = r.content ?? null;
  return NextResponse.json({ contents });
}
