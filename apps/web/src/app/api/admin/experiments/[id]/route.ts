import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { planExperimentPatch, toExperimentDTO } from '@/lib/experiments';
import { notFound, requirePlatformOwner } from '@/lib/admin/owner-gate';
import { applyExperimentUpdate, findOtherRunning, getExperiment } from '@/lib/admin/data';
import { recordPlatformAdminAudit } from '@/lib/admin/audit';
import { loadAdminViewer } from '@/lib/admin/scope';
import { viewExperiment } from '@/lib/admin/tenant-privacy';

/**
 * PATCH /api/admin/experiments/[id] — platform owner only (404 otherwise).
 *
 * The team route's change rules (planExperimentPatch) on any team's
 * experiment: status moves, fraction, config, visibility, title. Audited with
 * the experiment before and after; the response shows another team's
 * experiment without its team-written text, as the list does.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return gate.response;
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const row = await getExperiment(id);
  if (!row) return notFound();

  const body = await req.json().catch(() => undefined);
  const planned = planExperimentPatch(
    {
      kind: row.kind,
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
    const clash = await findOtherRunning(row.teamId, row.kind, row.id);
    if (clash) return NextResponse.json({ error: 'another_running', runningExperimentId: clash.id }, { status: 409 });
  }
  const updated = await applyExperimentUpdate(
    row.teamId,
    row.id,
    { status: row.status, policyVersion: row.policyVersion },
    set,
    starting ? { kind: row.kind } : null,
  );
  if (!updated) return NextResponse.json({ error: 'conflict' }, { status: 409 });

  const before = toExperimentDTO(row);
  const after = toExperimentDTO(updated);
  await recordPlatformAdminAudit({
    actorAccountId: gate.account.id,
    action: 'experiment.update',
    targetType: 'experiment',
    targetId: row.id,
    teamId: row.teamId,
    before: before as unknown as Record<string, unknown>,
    after: after as unknown as Record<string, unknown>,
  });
  const viewer = await loadAdminViewer(gate.account);
  return NextResponse.json({ experiment: viewExperiment(viewer, updated), policyVersionBumped: bumpedPolicyVersion });
}
