import { NextRequest, NextResponse } from 'next/server';
import {
  loadDecisionModelMeasurements,
  planMeasurementWrite,
  retireDecisionModelMeasurement,
  writeDecisionModelMeasurement,
  type StoredMeasurement,
} from '@buildd/core/decision-model-measurements';
import { notFound, requirePlatformOwner } from '@/lib/admin/owner-gate';
import { recordPlatformAdminAudit } from '@/lib/admin/audit';

/**
 * /api/admin/decisions/measurements — platform owner only (404 otherwise).
 *
 * Which model may act on which decision kind, and at what confidence
 * (packages/core/decision-model-measurements.ts). A stored row lets that model
 * act on that kind above its threshold from the next call (cached up to a
 * minute), with no shadow period; it stops applying when the kind's prompt
 * version changes, and a retired row records only.
 *
 * GET  → { measurements: [...] }, every stored row.
 * POST { kind, model, threshold, precisionLower?, coverage?, n, evalRunId?, measuredFingerprint, reason? }
 *      stores (or replaces) the (kind, model) row as measured now.
 * POST { action: 'retire', kind, model, reason? } marks it retired (404 when there is none).
 *
 * Every write is audited before it answers 200.
 */
const view = (r: StoredMeasurement) => ({ ...r, setAt: r.setAt.toISOString() });

export async function GET(req: NextRequest) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return gate.response;
  const rows = await loadDecisionModelMeasurements();
  return NextResponse.json({ measurements: rows.map(view) });
}

export async function POST(req: NextRequest) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return gate.response;

  const plan = planMeasurementWrite(await req.json().catch(() => null));
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: plan.status });

  const kind = plan.action === 'set' ? plan.row.kind : plan.kind;
  const model = plan.action === 'set' ? plan.row.model : plan.model;
  const before = (await loadDecisionModelMeasurements()).find(r => r.kind === kind && r.model === model) ?? null;
  const targetId = `${kind}|${model}`;

  if (plan.action === 'retire') {
    const after = await retireDecisionModelMeasurement({ kind, model, setByAccountId: gate.account.id, reason: plan.reason });
    if (!after) return notFound();
    await recordPlatformAdminAudit({
      actorAccountId: gate.account.id,
      action: 'decision_measurement.retire',
      targetType: 'decision_measurement',
      targetId,
      teamId: null,
      before: { status: before?.status ?? null, threshold: before?.threshold ?? null },
      after: { status: after.status, reason: plan.reason },
    });
    return NextResponse.json({ measurement: view(after) });
  }

  const written = await writeDecisionModelMeasurement({ ...plan.row, setByAccountId: gate.account.id });
  await recordPlatformAdminAudit({
    actorAccountId: gate.account.id,
    action: 'decision_measurement.update',
    targetType: 'decision_measurement',
    targetId,
    teamId: null,
    before: { threshold: before?.threshold ?? null, status: before?.status ?? null, measuredFingerprint: before?.measuredFingerprint ?? null },
    after: {
      threshold: written.threshold, status: written.status, measuredFingerprint: written.measuredFingerprint,
      n: written.n, precisionLower: written.precisionLower, coverage: written.coverage, evalRunId: written.evalRunId, reason: written.reason,
    },
  });
  return NextResponse.json({ measurement: view(written) });
}
