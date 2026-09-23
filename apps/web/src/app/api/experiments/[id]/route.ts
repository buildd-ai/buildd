/**
 * /api/experiments/[id]
 *
 * GET    one experiment. 404 when it is not on the caller's team OR is
 *        admins-only and the caller is below admin — never 403, so a member
 *        cannot tell a hidden experiment from a missing one.
 * PATCH  admin|owner. Edits title/hypothesis/visibility/treatmentFraction/
 *        config and moves status: draft→running, running⇄paused,
 *        →concluded (terminal, needs `decision`). Starting stamps startedAt
 *        and, for model_routing, 409s if another one is already running on
 *        the team. Changing fraction or config after the first start bumps
 *        policyVersion (see planExperimentPatch).
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveExperimentViewer } from '@/lib/experiment-access';
import { canViewExperiment, isExperimentAdmin, planExperimentPatch, toExperimentDTO } from '@/lib/experiments';
import { applyExperimentUpdate, findOtherRunning, getTeamExperiment } from '@/lib/experiments-store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: 'Experiment not found' }, { status: 404 });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const who = await resolveExperimentViewer(req, req.nextUrl.searchParams.get('workspaceId'));
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  if (!UUID_RE.test(id)) return notFound();

  const row = await getTeamExperiment(who.viewer.teamId, id);
  if (!row || !canViewExperiment(row.visibility, who.viewer.role)) return notFound();
  return NextResponse.json({ experiment: toExperimentDTO(row) });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const who = await resolveExperimentViewer(req, req.nextUrl.searchParams.get('workspaceId'));
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const { viewer } = who;
  if (!UUID_RE.test(id)) return notFound();

  const row = await getTeamExperiment(viewer.teamId, id);
  // Existence before role: a member probing an admins-only id must get the
  // same 404 as for an id that does not exist.
  if (!row || !canViewExperiment(row.visibility, viewer.role)) return notFound();
  if (!isExperimentAdmin(viewer.role)) {
    return NextResponse.json({ error: 'Changing an experiment requires team admin or owner' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const planned = planExperimentPatch(
    {
      status: row.status,
      treatmentFraction: Number(row.treatmentFraction),
      policyVersion: row.policyVersion,
      config: (row.config ?? {}) as Record<string, unknown>,
      startedAt: row.startedAt,
      decision: row.decision,
    },
    body,
    new Date(),
  );
  if (!planned.ok) return NextResponse.json({ error: planned.error }, { status: planned.status });
  const { set, transition, bumpedPolicyVersion } = planned.value;

  const starting = transition === 'running';
  if (starting) {
    const clash = await findOtherRunning(viewer.teamId, row.kind, row.id);
    if (clash) {
      return NextResponse.json(
        { error: `Experiment "${clash.key}" is already running on this team; pause or conclude it first`, runningExperimentId: clash.id },
        { status: 409 },
      );
    }
  }

  const updated = await applyExperimentUpdate(
    viewer.teamId,
    row.id,
    { status: row.status, policyVersion: row.policyVersion },
    set,
    starting ? { kind: row.kind } : null,
  );
  if (!updated) {
    return NextResponse.json(
      { error: 'Experiment changed concurrently, or another one started; reload and retry' },
      { status: 409 },
    );
  }
  return NextResponse.json({ experiment: toExperimentDTO(updated), policyVersionBumped: bumpedPolicyVersion });
}
