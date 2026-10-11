import { NextRequest, NextResponse } from 'next/server';
import {
  describeFeatureMode,
  loadDecisionFeatureMode,
  planFeatureSwitch,
  writeDecisionFeatureMode,
} from '@buildd/core/decision-feature-modes';
import { notFound, requirePlatformOwner } from '@/lib/admin/owner-gate';
import { recordPlatformAdminAudit } from '@/lib/admin/audit';

/**
 * POST /api/admin/decisions/features/[id]/mode — platform owner only (404 otherwise).
 *
 * Switch one decision feature between recording only and acting, for every
 * team that has it on (which teams have it stays the team flag). Body:
 * { mode: 'acting' | 'recording', threshold?, reason? }.
 *
 * - 200 { feature, ...the feature's mode view } after the write and its audit row.
 * - 409 with the reason when the feature has no switch (it acts or advises by
 *   design, or nothing calls it).
 * - Back to recording always succeeds: rolling back needs no evidence.
 *
 * A switch to acting pins the feature as deployed now (its measured identity
 * and threshold): a later change to its questions or model drops it back to
 * recording until it is switched on again.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return gate.response;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const plan = planFeatureSwitch(id, body);
  if (!plan.ok) {
    if (plan.status === 404) return notFound();
    return NextResponse.json({ error: plan.error }, { status: plan.status });
  }

  const before = await loadDecisionFeatureMode(id);
  const written = await writeDecisionFeatureMode({ ...plan.row, setByAccountId: gate.account.id });
  const view = describeFeatureMode(id, written);
  await recordPlatformAdminAudit({
    actorAccountId: gate.account.id,
    action: 'decision_feature.mode.update',
    targetType: 'decision_feature',
    targetId: id,
    teamId: null,
    before: { mode: describeFeatureMode(id, before).mode, threshold: before?.threshold ?? null, measuredFingerprint: before?.measuredFingerprint ?? null },
    after: { mode: view.mode, threshold: written.threshold, measuredFingerprint: written.measuredFingerprint, reason: written.reason },
  });
  return NextResponse.json({ feature: id, ...view });
}
