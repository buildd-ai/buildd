/**
 * DELETE /api/missions/[id]/visual-review/decisions/[reviewId]: undo a
 * decision (docs/design/visual-qa-human-review.md, part 1). Supersedes the
 * decision's reviews (both viewports of one tap), and reverses the fix it
 * filed or cancelled only while that task is pending and unclaimed; else
 * 409 `fix_started` and the review stays. Auth as for POST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { undoDecision } from '@/lib/visual-review-decisions';
import { isUuid } from '@/lib/uuid';
import { resolveDecisionMission } from '@/lib/visual-review-access';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; reviewId: string }> },
) {
  const { id, reviewId } = await params;
  const access = await resolveDecisionMission(id);
  if (!access.ok) return access.response;
  if (!isUuid(reviewId)) return NextResponse.json({ error: 'Review not found' }, { status: 404 });

  const out = await undoDecision({ mission: access.mission, reviewer: access.reviewer, reviewId });
  return NextResponse.json(out.body, { status: out.status, headers: { 'Cache-Control': 'private, no-store' } });
}
