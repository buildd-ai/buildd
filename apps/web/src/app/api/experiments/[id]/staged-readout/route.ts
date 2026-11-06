/**
 * GET /api/experiments/[id]/staged-readout — the staged self-review readout
 * alone: the same `stagedReview` that GET /readout returns (touch / flip rate,
 * label rubber_stamped | not_rubber_stamped | no_records). Limits come from the
 * experiment's stored killCriterion when present. Same gate as the other readouts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runStagedSelfReviewReadout } from '@buildd/core/staged-self-review-readout-source';
import { STAGED_SELF_REVIEW_FEATURE } from '@buildd/core/staged-draw';
import { bearerOf, resolveExperimentViewer } from '@/lib/experiment-access';
import { isTaskToken } from '@/lib/task-token';
import { canViewExperiment, toExperimentDTO } from '@/lib/experiments';
import { getTeamExperimentForReadout } from '@/lib/experiments-store';
import { isUuid } from '@/lib/uuid';

const notFound = () => NextResponse.json({ error: 'Experiment not found' }, { status: 404 });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (isTaskToken(bearerOf(req))) {
    return NextResponse.json({ error: 'A task token cannot read experiment readouts: they aggregate the whole team' }, { status: 403 });
  }
  const { id } = await params;
  const who = await resolveExperimentViewer(req, req.nextUrl.searchParams.get('workspaceId'));
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  if (!isUuid(id)) return notFound();
  const row = await getTeamExperimentForReadout(who.viewer.teamId, id);
  if (!row || !canViewExperiment(row.visibility, who.viewer)) return notFound();
  if (row.kind !== STAGED_SELF_REVIEW_FEATURE) {
    return NextResponse.json({ error: `No staged readout for experiment kind '${row.kind}'` }, { status: 422 });
  }
  const kc = ((row.config ?? {}) as { killCriterion?: { rubberStampTouchRate?: unknown; rubberStampFlipRate?: unknown } }).killCriterion;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  // Same function and same limits as GET /readout's stagedReview: one readout, two routes.
  const stagedReview = await runStagedSelfReviewReadout(
    { id: row.id, policyVersion: row.policyVersion },
    { touchRate: num(kc?.rubberStampTouchRate), flipRate: num(kc?.rubberStampFlipRate) },
  );
  return NextResponse.json({ experiment: toExperimentDTO(row), policyVersion: row.policyVersion, stagedReview });
}
