import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead } from '@/lib/admin/scope';
import { viewEstimates } from '@/lib/admin/tenant-privacy';

/** An estimator version name as the estimator writes it (e.g. `blend-v1`). */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * GET /api/admin/estimates — platform owner only (404 otherwise).
 *
 * Insights → Estimation: task-estimate calibration per estimator version
 * across teams, the backtest gate per version, coverage and write runtime
 * (docs/specs/task-estimates.md, "Platform operator surface"; response shape:
 * `OperatorEstimatesReport` in packages/core/task-estimate-operator.ts).
 * Query: window (24h|7d|30d, by estimate creation time), teamId?, workspaceId?,
 * version? (one estimator version; default every version in the window).
 * Read-only. Other teams contribute numbers; their names are pseudonyms and
 * their area labels are left out.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const version = read.params.get('version');
  if (version !== null && !VERSION_RE.test(version)) {
    return NextResponse.json({ error: 'version must be an estimator version name, e.g. blend-v1' }, { status: 400 });
  }
  try {
    const data = await viewEstimates(read.viewer, { since: read.scope.since, estimatorVersion: version });
    return NextResponse.json({ ...read.scope, since: read.scope.since.toISOString(), version, ...data });
  } catch (err) {
    console.error('[admin/estimates] readout failed:', (err as Error)?.name ?? 'Error');
    return NextResponse.json({ error: 'Estimates readout failed' }, { status: 500 });
  }
}
