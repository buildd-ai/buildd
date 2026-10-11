import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead } from '@/lib/admin/scope';
import { viewOperator } from '@/lib/admin/tenant-privacy';

/**
 * GET /api/admin/operator — platform owner only (404 otherwise).
 *
 * The Health → Operator panels not served by another admin route: delegated
 * subagent time, error-trace pattern cost, and PRs buildd cannot resolve.
 * A panel whose read failed is null. Query: window, teamId?, workspaceId?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const data = await viewOperator(read.viewer, read.scope.since);
  return NextResponse.json({ ...read.scope, since: read.scope.since.toISOString(), ...data });
}
