/**
 * GET /api/experiments/[id]/readout — the per-arm comparison
 * (computeExperimentReadout) for the experiment's CURRENT policy version.
 * Rows drawn under an earlier version were drawn with different settings and
 * are not pooled; `?policyVersion=N` reads an earlier one on its own.
 *
 * Same visibility gate as GET /api/experiments/[id]: hidden → 404.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runExperimentReadout } from '@buildd/core/experiment-readout-source';
import { parseModelRoutingConfig } from '@buildd/core/model-routing-experiment';
import { resolveExperimentViewer } from '@/lib/experiment-access';
import { canViewExperiment, toExperimentDTO } from '@/lib/experiments';
import { getTeamExperiment } from '@/lib/experiments-store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: 'Experiment not found' }, { status: 404 });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const who = await resolveExperimentViewer(req, req.nextUrl.searchParams.get('workspaceId'));
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  if (!UUID_RE.test(id)) return notFound();

  const row = await getTeamExperiment(who.viewer.teamId, id);
  if (!row || !canViewExperiment(row.visibility, who.viewer.role)) return notFound();

  let policyVersion = row.policyVersion;
  const pv = req.nextUrl.searchParams.get('policyVersion');
  if (pv !== null) {
    const n = Number(pv);
    if (!Number.isInteger(n) || n < 1 || n > row.policyVersion) {
      return NextResponse.json({ error: `policyVersion must be an integer from 1 to ${row.policyVersion}` }, { status: 400 });
    }
    policyVersion = n;
  }

  const { minSamplePerArm } = parseModelRoutingConfig(row.config);
  const readout = await runExperimentReadout({ id: row.id, policyVersion }, { minSamplePerArm });
  return NextResponse.json({ experiment: toExperimentDTO(row), policyVersion, readout });
}
