import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getLinksForEntity } from '@buildd/core/external-links';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { fetchLinearProgress, parseLinearUrl } from '@/lib/work-tracker';
import type { TrackerProgressResponse } from '@/lib/tracker-progress-types';

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

/**
 * Pure, DI-testable core of the mission tracker-progress read-back.
 *
 * Dependencies (link reader, Linear fetcher, URL parser) are injectable so this
 * can be unit-tested with a fake `db` and plain mock functions — no module
 * mocking (which bun leaks globally across test files, corrupting the Phase 1
 * link route + core external-links tests). Best-effort: a Linear fetch failure
 * leaves percent/state null while keeping `linked: true`.
 */
export async function missionTrackerProgress(
  database: typeof db,
  args: { missionId: string; teamId: string; connectorId: string | null },
  deps: {
    getLinks?: typeof getLinksForEntity;
    fetchProgress?: typeof fetchLinearProgress;
    parseUrl?: typeof parseLinearUrl;
  } = {},
): Promise<TrackerProgressResponse> {
  const getLinks = deps.getLinks ?? getLinksForEntity;
  const fetchProgress = deps.fetchProgress ?? fetchLinearProgress;
  const parseUrl = deps.parseUrl ?? parseLinearUrl;

  const fetchedAt = new Date().toISOString();

  const links = await getLinks(database, 'mission', args.missionId);
  const linearLink = links.find((l) => l.provider === 'linear' && l.externalId);

  if (!linearLink || !linearLink.externalId) {
    return { linked: false, provider: null, items: [], fetchedAt };
  }

  const kind = parseUrl(linearLink.externalUrl)?.type ?? 'project';

  // Best-effort: no connector / dead token / GraphQL error → null progress, still linked.
  const progress = args.connectorId
    ? await fetchProgress({
        connectorId: args.connectorId,
        teamId: args.teamId,
        externalId: linearLink.externalId,
        kind,
      })
    : null;

  return {
    linked: true,
    provider: 'linear',
    items: [
      {
        kind,
        externalId: linearLink.externalId,
        title: progress?.title ?? null,
        percent: progress?.percent ?? null,
        state: progress?.state ?? null,
        url: linearLink.externalUrl ?? null,
      },
    ],
    fetchedAt,
  };
}

// GET /api/missions/[id]/tracker-progress — best-effort Linear read-back (Phase 2).
export async function GET(
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

    // Resolve the connector for the Linear read from the workspace config.
    let connectorId: string | null = null;
    if (mission.workspaceId) {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, mission.workspaceId),
        columns: { workTrackerConfig: true },
      });
      if (ws?.workTrackerConfig?.provider === 'linear') {
        connectorId = ws.workTrackerConfig.connectorId ?? null;
      }
    }

    const response = await missionTrackerProgress(db, {
      missionId: id,
      teamId: mission.teamId,
      connectorId,
    });
    return NextResponse.json(response);
  } catch (error) {
    console.error('Get mission tracker-progress error:', error);
    return NextResponse.json({ error: 'Failed to get tracker progress' }, { status: 500 });
  }
}
