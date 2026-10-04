/**
 * GET /api/experiments/[id]/readout — the per-arm comparison
 * (computeExperimentReadout) for the experiment's CURRENT policy version.
 * Rows drawn under an earlier version were drawn with different settings and
 * are not pooled; `?policyVersion=N` reads an earlier one on its own.
 *
 * Same visibility gate as GET /api/experiments/[id]: hidden → 404.
 *
 * Each kind has its own readout, dispatched explicitly: the two-arm task
 * readout joins on tasks, so any kind whose units are not tasks (a chat
 * tier pool's turns) would read as all zeros through it. A kind with no
 * readout is a 422, never a silent fall-through.
 *
 * Refused to a per-task token: a readout and its enrolment health count
 * tasks across every workspace on the team, and cannot be narrowed to the
 * token's one workspace without changing what the experiment measures.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runExperimentReadout } from '@buildd/core/experiment-readout-source';
import { MODEL_ROUTING_EXPERIMENT_KIND, parseModelRoutingConfig } from '@buildd/core/model-routing-experiment';
import { CBM_ACCESS_EXPERIMENT_KIND } from '@buildd/core/cbm-access-experiment';
import { TIER_POOL_EXPERIMENT_KIND } from '@buildd/core/tier-pool';
import { runTierPoolReadout } from '@buildd/core/tier-pool-admin';
import { runHeartbeatTriageReadout } from '@buildd/core/heartbeat-triage-readout-source';
import { HEARTBEAT_TRIAGE_EXPERIMENT_KIND, parseHeartbeatTriageConfig } from '@buildd/core/heartbeat-triage-experiment';
import { bearerOf, resolveExperimentViewer } from '@/lib/experiment-access';
import { isTaskToken } from '@/lib/task-token';
import { canViewExperiment, toExperimentDTO } from '@/lib/experiments';
import { getTeamExperimentForReadout } from '@/lib/experiments-store';
import { runExperimentHealth } from '@buildd/core/experiment-health-source';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: 'Experiment not found' }, { status: 404 });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (isTaskToken(bearerOf(req))) {
    return NextResponse.json({ error: 'A task token cannot read experiment readouts: they aggregate the whole team' }, { status: 403 });
  }
  const { id } = await params;
  const who = await resolveExperimentViewer(req, req.nextUrl.searchParams.get('workspaceId'));
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  if (!UUID_RE.test(id)) return notFound();

  const row = await getTeamExperimentForReadout(who.viewer.teamId, id);
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

  // Enrolment health (starved, unbalanced, past its cap) of the running
  // experiment — lib in packages/core/experiment-health.ts. Never fails the readout.
  const health = await runExperimentHealth(row).catch(() => null);

  // Heartbeat triage is measured per mission, over its own look rows, not per task.
  if (row.kind === HEARTBEAT_TRIAGE_EXPERIMENT_KIND) {
    const readout = await runHeartbeatTriageReadout({ id: row.id, policyVersion }, parseHeartbeatTriageConfig(row.config));
    return NextResponse.json({ experiment: toExperimentDTO(row), policyVersion, readout, health });
  }
  // Tier pools are measured per arm over their own assignment rows (chat turns or tasks).
  if (row.kind === TIER_POOL_EXPERIMENT_KIND) {
    const readout = await runTierPoolReadout({ id: row.id, policyVersion });
    return NextResponse.json({ experiment: toExperimentDTO(row), policyVersion, readout, health });
  }
  if (row.kind !== MODEL_ROUTING_EXPERIMENT_KIND && row.kind !== CBM_ACCESS_EXPERIMENT_KIND) {
    return NextResponse.json({ error: `No readout for experiment kind '${row.kind}'` }, { status: 422 });
  }
  const { minSamplePerArm } = parseModelRoutingConfig(row.config);
  const readout = await runExperimentReadout({ id: row.id, policyVersion }, { minSamplePerArm });
  return NextResponse.json({ experiment: toExperimentDTO(row), policyVersion, readout, health });
}
