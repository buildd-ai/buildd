import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead, intParam } from '@/lib/admin/scope';
import { viewRootCause } from '@/lib/admin/tenant-privacy';
import { listRootCauses } from '@/lib/root-cause-record';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * GET /api/admin/root-causes — platform owner only (404 otherwise, including
 * to a team API key and to any browser session).
 *
 * Every active root cause, plus those verified restored within the window,
 * newest sighting first. A record is classification only; whatever state an
 * operator client keeps about one is its own. Query: window, teamId?, limit?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const limit = intParam(read.params, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const records = await listRootCauses({ teamIds: read.scope.teamId ? [read.scope.teamId] : null, since: read.scope.since, limit });
  return NextResponse.json({
    ...read.scope,
    since: read.scope.since.toISOString(),
    rootCauses: records.map(r => viewRootCause(read.viewer, r)),
  });
}
