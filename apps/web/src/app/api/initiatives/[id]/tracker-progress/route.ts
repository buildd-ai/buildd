import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { initiatives, missions, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getLinksForEntity } from '@buildd/core/external-links';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { fetchLinearProgress, parseLinearUrl } from '@/lib/work-tracker';
import type { TrackerProgressItem, TrackerProgressResponse } from '@/lib/tracker-progress-types';

/** Check if an initiative is accessible: team match OR open-access workspace. */
async function hasInitiativeAccess(
  initiative: { teamId: string; workspaceId: string | null },
  teamIds: string[],
): Promise<boolean> {
  if (teamIds.includes(initiative.teamId)) return true;
  if (initiative.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, initiative.workspaceId),
      columns: { accessMode: true },
    });
    if (ws?.accessMode === 'open') return true;
  }
  return false;
}

type ChildMission = { id: string; title: string | null; teamId: string; workspaceId: string | null };

/** Default child-mission loader — the initiative's directly linked missions. */
async function loadChildMissions(database: typeof db, initiativeId: string): Promise<ChildMission[]> {
  return database.query.missions.findMany({
    where: eq(missions.initiativeId, initiativeId),
    columns: { id: true, title: true, teamId: true, workspaceId: true },
  }) as unknown as Promise<ChildMission[]>;
}

/** Default connector resolver — the Linear connectorId from a workspace's work-tracker config. */
async function loadWorkspaceConnectorId(
  database: typeof db,
  workspaceId: string,
): Promise<string | null> {
  const ws = await database.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { workTrackerConfig: true },
  });
  return ws?.workTrackerConfig?.provider === 'linear' ? ws.workTrackerConfig.connectorId ?? null : null;
}

/**
 * Pure, DI-testable core of the initiative tracker-progress read-back.
 *
 * Aggregates Linear read-back across the initiative's linked child missions.
 * Every collaborator (child loader, link reader, connector resolver, Linear
 * fetcher, URL parser) is injectable so this can be unit-tested with a fake `db`
 * and plain mock functions — no module mocking (which bun leaks globally across
 * test files). Best-effort: per-child fetch failures null percent/state but the
 * child still contributes an item.
 */
export async function initiativeTrackerProgress(
  database: typeof db,
  args: { initiativeId: string },
  deps: {
    getChildMissions?: (database: typeof db, initiativeId: string) => Promise<ChildMission[]>;
    getLinks?: typeof getLinksForEntity;
    getConnectorId?: (database: typeof db, workspaceId: string) => Promise<string | null>;
    fetchProgress?: typeof fetchLinearProgress;
    parseUrl?: typeof parseLinearUrl;
  } = {},
): Promise<TrackerProgressResponse> {
  const getChildMissions = deps.getChildMissions ?? loadChildMissions;
  const getLinks = deps.getLinks ?? getLinksForEntity;
  const getConnectorId = deps.getConnectorId ?? loadWorkspaceConnectorId;
  const fetchProgress = deps.fetchProgress ?? fetchLinearProgress;
  const parseUrl = deps.parseUrl ?? parseLinearUrl;

  const fetchedAt = new Date().toISOString();

  const childMissions = await getChildMissions(database, args.initiativeId);

  // Cache workspace→connectorId lookups so N children in one workspace hit the DB once.
  const connectorByWorkspace = new Map<string, string | null>();
  const resolveConnectorId = async (workspaceId: string | null): Promise<string | null> => {
    if (!workspaceId) return null;
    if (connectorByWorkspace.has(workspaceId)) return connectorByWorkspace.get(workspaceId)!;
    const connectorId = await getConnectorId(database, workspaceId);
    connectorByWorkspace.set(workspaceId, connectorId);
    return connectorId;
  };

  const items: TrackerProgressItem[] = [];
  for (const mission of childMissions) {
    const links = await getLinks(database, 'mission', mission.id);
    const linearLink = links.find((l) => l.provider === 'linear' && l.externalId);
    if (!linearLink || !linearLink.externalId) continue;

    const kind = parseUrl(linearLink.externalUrl)?.type ?? 'project';
    const connectorId = await resolveConnectorId(mission.workspaceId);
    const progress = connectorId
      ? await fetchProgress({
          connectorId,
          teamId: mission.teamId,
          externalId: linearLink.externalId,
          kind,
        })
      : null;

    items.push({
      kind,
      externalId: linearLink.externalId,
      // Initiative rollup uses the buildd mission's title as the row label.
      title: mission.title ?? null,
      percent: progress?.percent ?? null,
      state: progress?.state ?? null,
      url: linearLink.externalUrl ?? null,
    });
  }

  return {
    linked: items.length > 0,
    provider: items.length > 0 ? 'linear' : null,
    items,
    fetchedAt,
  };
}

// GET /api/initiatives/[id]/tracker-progress — aggregates Linear read-back across
// the initiative's linked child missions (Phase 2). Best-effort, never 500s on a
// Linear failure.
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

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const initiative = await db.query.initiatives.findFirst({
      where: eq(initiatives.id, id),
      columns: { id: true, teamId: true, workspaceId: true },
    });

    if (!initiative || !(await hasInitiativeAccess(initiative, teamIds))) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
    }

    const response = await initiativeTrackerProgress(db, { initiativeId: id });
    return NextResponse.json(response);
  } catch (error) {
    console.error('Get initiative tracker-progress error:', error);
    return NextResponse.json({ error: 'Failed to get tracker progress' }, { status: 500 });
  }
}
