/**
 * POST /api/missions/[id]/visual-review/decisions: a human's Looks right /
 * Needs fix on 1..50 audit shots (docs/design/visual-qa-human-review.md,
 * part 1 and "Write"). The server derives agree / dispute / waive from the
 * agent's verdict and does what it implies: files a `[surface fix]`, waives
 * the auditor's fix, or sends it guidance (`applyDecision`).
 *
 * Auth: the dashboard session only, which is also how the in-process chat
 * API calls it. A decision is a person's judgement, so an API key is never a
 * reviewer. Access is membership of the mission's team plus the mission's
 * workspace, as for the GET; anything else is a 404. Every artifact must be
 * an auditor shot of this mission (422 otherwise).
 */
import { NextRequest, NextResponse } from 'next/server';
import { applyDecision, parseDecisionRequest } from '@/lib/visual-review-decisions';
import { resolveDecisionMission } from '@/lib/visual-review-access';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await resolveDecisionMission(id);
  if (!access.ok) return access.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  const parsed = parseDecisionRequest(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const out = await applyDecision({ mission: access.mission, reviewer: access.reviewer, request: parsed.request });
  return NextResponse.json(out.body, { status: out.status, headers: { 'Cache-Control': 'private, no-store' } });
}
