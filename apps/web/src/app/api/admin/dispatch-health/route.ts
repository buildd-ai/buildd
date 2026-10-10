import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead } from '@/lib/admin/scope';
import { loadDispatchHealth } from '@/lib/admin/data';

/**
 * GET /api/admin/dispatch-health — platform owner only (404 otherwise).
 *
 * The dispatch_health report (verdict, outbox, latency) over any scope.
 * Query: teamId?, workspaceId?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  return NextResponse.json({ teamId: read.scope.teamId, workspaceId: read.scope.workspaceId, report: await loadDispatchHealth(read.workspaceIds) });
}
