/**
 * POST /api/missions/[id]/visual-review/report: "Report a Buildd problem".
 *
 * A person tells us the visual check itself could not run. The body is ignored:
 * the diagnostics are built here from the mission's own derived state
 * (`visualReviewDiagnostics`, a closed field list), so nothing a page or a
 * caller types, no URL and no token, can reach the record. It lands as a mission
 * note under its own title, apart from the review's product findings.
 */
import { NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { postMissionFeedEvent } from '@/lib/mission-feed';
import { isUuid } from '@/lib/uuid';
import { getMissionVisualReviewState } from '@/lib/workflow/visual-review-state-load';
import { visualReviewDiagnostics } from '@/lib/workflow/visual-review-copy';

export const VISUAL_REVIEW_REPORT_NOTE_TITLE = 'Visual review problem reported';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const mission = await db.query.missions.findFirst({ where: eq(missions.id, id), columns: { id: true, teamId: true } });
  const teamIds = mission ? await getUserTeamIds(user.id) : [];
  if (!mission || !teamIds.includes(mission.teamId)) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });

  const state = await getMissionVisualReviewState(id);
  if (!state) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });

  const diagnostics = visualReviewDiagnostics(state);
  await postMissionFeedEvent({
    missionId: id,
    type: 'update',
    title: VISUAL_REVIEW_REPORT_NOTE_TITLE,
    body: JSON.stringify(diagnostics),
    actor: { kind: 'user', id: user.id, label: user.email ?? 'a team member' },
    collapseKey: 'visual-review-report',
  });
  return NextResponse.json({ ok: true, diagnostics });
}
