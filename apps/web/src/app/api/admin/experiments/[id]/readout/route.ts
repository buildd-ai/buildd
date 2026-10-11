import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { toExperimentDTO } from '@/lib/experiments';
import { notFound, requirePlatformOwner } from '@/lib/admin/owner-gate';
import { getExperiment, loadExperimentReadout } from '@/lib/admin/data';

/**
 * GET /api/admin/experiments/[id]/readout — platform owner only (404 otherwise).
 *
 * The per-arm readout of any team's experiment for its current policy
 * version, the same computation as the team route. `readout` is null for a
 * kind that has none.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return gate.response;
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const row = await getExperiment(id);
  if (!row) return notFound();
  const { policyVersion, readout, health } = await loadExperimentReadout(row);
  return NextResponse.json({ experiment: { ...toExperimentDTO(row), teamId: row.teamId }, policyVersion, readout, health });
}
