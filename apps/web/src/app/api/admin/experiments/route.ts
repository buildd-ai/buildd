import { NextRequest, NextResponse } from 'next/server';
import { toExperimentDTO } from '@/lib/experiments';
import { beginAdminRead } from '@/lib/admin/scope';
import { listExperiments, loadExperimentHealth } from '@/lib/admin/data';

/**
 * GET /api/admin/experiments — platform owner only (404 otherwise).
 *
 * Every team's experiments regardless of visibility, each with its teamId,
 * and enrolment health for the running ones. Query: teamId?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const rows = await listExperiments({ teamId: read.scope.teamId });
  const health = await loadExperimentHealth(rows);
  return NextResponse.json({
    experiments: rows.map(r => ({ ...toExperimentDTO(r), teamId: r.teamId })),
    health,
  });
}
