import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead } from '@/lib/admin/scope';
import { loadDecisionFeatureCounts, loadDecisionHealthRows } from '@/lib/admin/data';
import { featureHealthById, groupDecisionFeatures } from '@/lib/admin/decision-features';
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
 *
 * Each feature also carries `health` (packages/core/decision-feature-health.ts):
 * whether it is deciding at all, in one plain sentence naming the fix, then
 * calls, acted %, fallback % by reason, latency p50/p95, cost, agent-graded
 * accuracy with its Wilson interval, the rule's accuracy on the same sample
 * and the human override rate. `healthTruncated` says the row cap was hit.
 * Query: window=24h|7d|30d (default 7d), teamId?, workspaceId?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const [counts, modes, health] = await Promise.all([
    loadDecisionFeatureCounts({ since: read.scope.since, workspaceIds: read.workspaceIds }),
    loadDecisionFeatureModes(),
    loadDecisionHealthRows({ since: read.scope.since, workspaceIds: read.workspaceIds }),
  ]);
  return NextResponse.json({
    ...read.scope,
    since: read.scope.since.toISOString(),
    ...groupDecisionFeatures(counts, modes, featureHealthById(health.rows, health.outcomes)),
    healthTruncated: health.truncated,
  });
}
