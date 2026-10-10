import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead } from '@/lib/admin/scope';
import { loadDecisionFeatureCounts } from '@/lib/admin/data';
import { groupDecisionFeatures } from '@/lib/admin/decision-features';

/**
 * GET /api/admin/decisions/features — platform owner only (404 otherwise).
 *
 * Every inference capability, grouped by kind, with its decision-ledger counts
 * (applied / suggested / fallback / overridden) and cost over the window.
 * Query: window=24h|7d|30d (default 7d), teamId?, workspaceId?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const counts = await loadDecisionFeatureCounts({ since: read.scope.since, workspaceIds: read.workspaceIds });
  return NextResponse.json({ ...read.scope, since: read.scope.since.toISOString(), ...groupDecisionFeatures(counts) });
}
