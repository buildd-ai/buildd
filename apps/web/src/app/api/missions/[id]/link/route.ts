import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { linkExternal } from '@buildd/core/external-links';
import { parseLinearUrl, getConnectorAccessToken, linearGraphQL } from '@/lib/work-tracker';

/** Check if a mission is accessible: team match OR open-access workspace. */
async function hasMissionAccess(
  mission: { teamId: string; workspaceId: string | null },
  teamIds: string[],
): Promise<boolean> {
  if (teamIds.includes(mission.teamId)) return true;
  if (mission.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, mission.workspaceId),
      columns: { accessMode: true },
    });
    if (ws?.accessMode === 'open') return true;
  }
  return false;
}

// POST /api/missions/[id]/link — link a mission to an external tracker project/issue.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: { id: true, teamId: true, workspaceId: true },
    });

    if (!mission || !(await hasMissionAccess(mission, teamIds))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    // Resolve the workspace's work-tracker config. A Linear connector is required.
    if (!mission.workspaceId) {
      return NextResponse.json(
        { error: 'Mission has no workspace with a Linear connector configured' },
        { status: 400 },
      );
    }
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, mission.workspaceId),
      columns: { workTrackerConfig: true },
    });
    const config = ws?.workTrackerConfig;
    if (!config || config.provider !== 'linear' || !config.connectorId) {
      return NextResponse.json(
        { error: 'Workspace has no Linear connector configured (set a Linear work tracker first)' },
        { status: 400 },
      );
    }

    // Deterministic id from the URL — idempotency depends on this being stable.
    const parsed = parseLinearUrl(url);
    if (!parsed) {
      return NextResponse.json(
        { error: 'Could not parse a Linear project or issue id from the URL' },
        { status: 400 },
      );
    }
    const externalId = parsed.externalId;

    // Best-effort validation via Linear GraphQL — must NOT block linking.
    try {
      const token = await getConnectorAccessToken(config.connectorId, mission.teamId);
      if (token) {
        const ok = await linearGraphQL(
          token,
          `query ValidateEntity($id: String!) {
            ${parsed.type === 'issue' ? 'issue' : 'project'}(id: $id) { id }
          }`,
          { id: externalId },
        );
        if (!ok) {
          console.warn(`[missions/link] Linear validation returned no data for ${externalId}; linking anyway`);
        }
      }
    } catch (err) {
      console.warn('[missions/link] Linear validation failed, proceeding with parsed id:', err);
    }

    // Write the canonical link row first, then dual-write the mission column so the
    // existing completion-push path keeps working unchanged.
    const link = await linkExternal(db, {
      teamId: mission.teamId,
      provider: 'linear',
      builddEntityType: 'mission',
      builddEntityId: mission.id,
      externalId,
      externalUrl: url,
    });

    await db
      .update(missions)
      .set({ externalIssueId: externalId, externalIssueUrl: url, updatedAt: new Date() })
      .where(eq(missions.id, mission.id));

    return NextResponse.json(link);
  } catch (error) {
    console.error('Link mission error:', error);
    return NextResponse.json({ error: 'Failed to link mission' }, { status: 500 });
  }
}
