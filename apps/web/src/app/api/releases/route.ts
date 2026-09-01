import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { listReleasesQuery } from '@/lib/release-queries';

/**
 * GET /api/releases?workspaceId=&missionId=&state=&limit=
 *
 * Read-only release history for a workspace. Backs the `list_releases` MCP
 * action (both the API-key and OAuth transports go through this route) —
 * see apps/web/src/lib/release-queries.ts for the shared query logic.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount && process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspaceId');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  if (!ws) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (apiAccount) {
    if (apiAccount.teamId !== ws.teamId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else if (user) {
    const teamIds = await getUserTeamIds(user.id);
    if (!teamIds.includes(ws.teamId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const missionId = searchParams.get('missionId') || undefined;
  const state = searchParams.get('state') || undefined;
  const limitParam = searchParams.get('limit');

  const releaseRows = await listReleasesQuery({
    workspaceId,
    missionId,
    state,
    limit: limitParam ? Number(limitParam) : undefined,
  });

  return NextResponse.json({ releases: releaseRows });
}
