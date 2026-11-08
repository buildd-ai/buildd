import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { loadModelComparison, parseComparisonFilters } from '@/lib/model-comparison-query';

/**
 * GET /api/model-comparison?workspaceId=<id>&model=&config=&harness=&hardware=&taskType=&window=|since=&until=
 *
 * Per-model/configuration comparison of one workspace's model observations
 * (packages/core/model-comparison.ts). Read-only and advisory: the response
 * says `autoPromote: false` and nothing here changes routing. A workspace the
 * caller cannot access answers 404, exactly like one that does not exist.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  if (apiKey) {
    const account = await authenticateApiKey(apiKey, req);
    if (!account) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    if (!(await verifyAccountWorkspaceAccess(account, workspaceId))) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  } else {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await verifyWorkspaceAccess(user.id, workspaceId))) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  }

  const parsed = parseComparisonFilters((k) => url.searchParams.get(k));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return NextResponse.json(await loadModelComparison(workspaceId, parsed.filters));
}
