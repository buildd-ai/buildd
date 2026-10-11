import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { beginAdminRead } from '@/lib/admin/scope';
import { loadDecisionStats } from '@/lib/admin/data';

/**
 * GET /api/admin/decisions/stats — platform owner only (404 otherwise).
 *
 * The get_decision_stats report (orchestration decisions and manifest
 * predictions) over any scope. Query: window, teamId?, workspaceId?, missionId?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const missionId = read.params.get('missionId');
  if (missionId !== null && !isUuid(missionId)) return NextResponse.json({ error: 'missionId must be a UUID' }, { status: 400 });
  const stats = await loadDecisionStats({ workspaceIds: read.workspaceIds, window: read.scope.window, ...(missionId ? { missionId } : {}) });
  return NextResponse.json({ ...read.scope, since: read.scope.since.toISOString(), stats });
}
