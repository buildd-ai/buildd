import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_WINDOWS, beginAdminRead } from '@/lib/admin/scope';
import { loadAgentAccess } from '@/lib/admin/data';

/**
 * GET /api/admin/agent-access — platform owner only (404 otherwise).
 *
 * Health → Overview's agent access section: capability grants and refusals in
 * the window. Query: window, teamId?, workspaceId?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const windowHours = ADMIN_WINDOWS[read.scope.window] * 24;
  const report = await loadAgentAccess({ workspaceIds: read.workspaceIds, windowHours });
  return NextResponse.json({ ...read.scope, since: read.scope.since.toISOString(), report });
}
