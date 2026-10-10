import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead } from '@/lib/admin/scope';
import { loadInsights } from '@/lib/admin/data';

/**
 * GET /api/admin/insights — platform owner only (404 otherwise).
 *
 * Health → Insights: how agent work moved to production (flow series) and its
 * role/tier usage counters. The series has 7 and 30 day windows; 24h reads 7d.
 * Query: window, teamId?, workspaceId?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const window = read.scope.window === '30d' ? '30d' : '7d';
  const data = await loadInsights({ workspaceIds: read.workspaceIds, window });
  return NextResponse.json({ ...read.scope, since: read.scope.since.toISOString(), flowWindow: window, ...data });
}
