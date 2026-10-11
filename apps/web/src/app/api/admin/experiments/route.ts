import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead } from '@/lib/admin/scope';
import { viewExperiment } from '@/lib/admin/tenant-privacy';
import { listExperiments, loadExperimentHealth } from '@/lib/admin/data';

/**
 * GET /api/admin/experiments — platform owner only (404 otherwise).
 *
 * Every team's experiments regardless of visibility, each with its teamId,
 * and enrolment health for the running ones. Another team's experiment shows
 * no team-written text (lib/admin/tenant-privacy.ts). Query: teamId?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const rows = await listExperiments({ teamId: read.scope.teamId });
  const health = await loadExperimentHealth(rows);
  return NextResponse.json({
    experiments: rows.map(r => viewExperiment(read.viewer, r)),
    health,
  });
}
