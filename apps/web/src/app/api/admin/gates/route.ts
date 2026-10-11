import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead } from '@/lib/admin/scope';
import { loadGates } from '@/lib/admin/data';

/**
 * GET /api/admin/gates — platform owner only (404 otherwise).
 *
 * The gate ledger (get_failure_analytics family=gate): refusals, deferrals,
 * advisory warnings and bypasses. With errorPrefix, the rollup of the reasons
 * sharing that prefix; without, the overview plus time-to-land.
 * Query: window, teamId?, workspaceId?, errorPrefix?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const errorPrefix = read.params.get('errorPrefix')?.trim().slice(0, 200) || null;
  const data = await loadGates({ workspaceIds: read.workspaceIds, window: read.scope.window, errorPrefix });
  return NextResponse.json({ ...read.scope, since: read.scope.since.toISOString(), errorPrefix, ...data });
}
