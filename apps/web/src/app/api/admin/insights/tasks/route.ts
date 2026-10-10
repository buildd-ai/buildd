import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead } from '@/lib/admin/scope';
import { loadInsightsBand } from '@/lib/admin/data';
import { parseBandFilter } from '@/components/insights/usage-model';

/**
 * GET /api/admin/insights/tasks — platform owner only (404 otherwise).
 *
 * The tasks behind one band of one Insights bucket. Query: band, from, to, at
 * (epoch ms, as the Insights chart links them; to - from is 7 or 30 days),
 * teamId?, workspaceId?. 400 without a valid band filter; 404 when the bucket
 * is outside the series.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const p = read.params;
  const filter = parseBandFilter({
    band: p.get('band') ?? undefined, from: p.get('from') ?? undefined,
    to: p.get('to') ?? undefined, at: p.get('at') ?? undefined,
  });
  if (!filter) return NextResponse.json({ error: 'band, from, to and at are required (to - from is 7 or 30 days)' }, { status: 400 });
  const data = await loadInsightsBand({ workspaceIds: read.workspaceIds, filter });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ teamId: read.scope.teamId, workspaceId: read.scope.workspaceId, ...data });
}
