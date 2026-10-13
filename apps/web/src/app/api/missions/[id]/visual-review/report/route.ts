/**
 * POST /api/missions/[id]/visual-review/report: "Report a Buildd problem" for a
 * visual check that could not run. Not a visual finding: it is recorded on the
 * mission feed as its own entry and never touches the review's screens or
 * decisions.
 *
 * Auth: the dashboard session, same access rule as the decisions routes. The
 * diagnostics are built here from the canonical state, not taken from the
 * client, and pass through `redactDiagnosticText` (no links, tokens or
 * addresses). A state with no system failure answers 409.
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveDecisionMission } from '@/lib/visual-review-access';
import { getMissionVisualReviewState } from '@/lib/workflow/visual-review-state-load';
import { buildProblemReport } from '@/lib/workflow/visual-review-diagnostics';
import { postMissionFeedEvent } from '@/lib/mission-feed';

const PROBLEM_REPORT_NOTE_TITLE = 'Buildd problem reported';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await resolveDecisionMission(id);
  if (!access.ok) return access.response;
  const reporterId = access.reviewer.userId;
  if (!reporterId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let note: string | null = null;
  try {
    const raw = await req.json();
    if (raw && typeof raw === 'object' && typeof (raw as { note?: unknown }).note === 'string') note = (raw as { note: string }).note;
  } catch {
    // The note is optional; an empty body is a plain report.
  }

  const state = await getMissionVisualReviewState(access.mission.id);
  const report = state ? buildProblemReport(state, { note }) : null;
  if (!report) {
    return NextResponse.json({ error: 'There is no problem with the visual check to report.' }, { status: 409 });
  }

  await postMissionFeedEvent({
    missionId: access.mission.id,
    type: 'update',
    title: PROBLEM_REPORT_NOTE_TITLE,
    body: `${report.title}\n${report.body}`,
    actor: { kind: 'user', id: reporterId, label: access.reviewer.label ?? reporterId },
    // One report per failing check; a second press folds into it.
    collapseKey: `visual-review-problem:${state?.auditTaskId ?? access.mission.id}`,
    collapseWindowMs: 24 * 60 * 60_000,
  });
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
}
