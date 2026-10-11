import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead } from '@/lib/admin/scope';
import { loadDecisionFeatureCounts } from '@/lib/admin/data';
import { groupDecisionFeatures } from '@/lib/admin/decision-features';
import { loadDecisionFeatureModes } from '@buildd/core/decision-feature-modes';

/**
 * GET /api/admin/decisions/features — platform owner only (404 otherwise).
 *
 * Every inference capability, grouped by kind, with its decision-ledger counts
 * (applied / suggested / fallback / overridden) and cost over the window, plus
 * what each does once a team has it on: mode ('acting' | 'recording'), effect,
 * whether the owner can switch it (switchable / canAct / cannotActReason),
 * actingSince and threshold while switched on, and `stale` when a switch no
 * longer matches the feature. Switch with POST decisions/features/[id]/mode.
 * Query: window=24h|7d|30d (default 7d), teamId?, workspaceId?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const [counts, modes] = await Promise.all([
    loadDecisionFeatureCounts({ since: read.scope.since, workspaceIds: read.workspaceIds }),
    loadDecisionFeatureModes(),
  ]);
  return NextResponse.json({ ...read.scope, since: read.scope.since.toISOString(), ...groupDecisionFeatures(counts, modes) });
}
