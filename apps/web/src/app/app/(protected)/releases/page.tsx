import { db } from '@buildd/core/db';
import { releases, tasks, workspaces } from '@buildd/core/db/schema';
import { count, eq, inArray, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { teamIdsWhere } from '@/lib/permissions';
import { releaseCandidatePolicy } from '@buildd/core/release-candidate';
import { supersededById } from './release-display';
import { ReleasesHeader, ReleasesList } from './ReleasesList';
import { releasesFixture, resolveReleasesFixtureState } from './releases-fixtures';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/** How many releases the list shows; the count line says when there are more. */
const LIST_LIMIT = 100;

export default async function ReleasesPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; state?: string | string[] }>;
}) {
  const { workspace: wsFilter, state } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  // `?state=` (dev server only) draws the list from synthetic rows; see ./releases-fixtures.ts.
  const fixtureState = resolveReleasesFixtureState(state);
  if (fixtureState) return <ReleasesList {...releasesFixture(fixtureState)} />;

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return (
      <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
        <ReleasesHeader />
        <p className="text-body text-text-secondary">
          No team. <Link href="/app/settings/team?new=1" className="text-text-primary underline underline-offset-2">Create a team</Link> to track releases.
        </p>
      </div>
    );
  }

  const cookieStore = await cookies();
  const activeTeamId =
    (await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value)) ?? teamIds[0];

  // Load active team's workspaces and filter to release-enabled ones
  const teamWorkspaces = await db
    .select({ id: workspaces.id, name: workspaces.name, releaseConfig: workspaces.releaseConfig, gitConfig: workspaces.gitConfig })
    .from(workspaces)
    .where(eq(workspaces.teamId, activeTeamId));

  const releaseEnabledWorkspaces = teamWorkspaces.filter(ws => {
    const releaseConfig = ws.releaseConfig as any;
    return releaseConfig?.enabled === true;
  });

  // Filter to selected workspace if provided
  const targetWsIds = wsFilter
    ? releaseEnabledWorkspaces.filter(ws => ws.id === wsFilter).map(ws => ws.id)
    : releaseEnabledWorkspaces.map(ws => ws.id);

  if (targetWsIds.length === 0) {
    return (
      <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
        <ReleasesHeader />
        <p className="text-body text-text-secondary">No releases. Set them up in a workspace&apos;s settings.</p>
      </div>
    );
  }

  // Fetch releases for the filtered workspaces, eager-loading task attribution,
  // and the real total under the same scope (the list is capped; the count is not).
  const [allReleases, [{ total }]] = await Promise.all([
    db.query.releases.findMany({
      where: inArray(releases.workspaceId, targetWsIds),
      orderBy: [desc(releases.createdAt)],
      limit: LIST_LIMIT,
      with: { releaseTasks: { columns: { taskId: true } } },
    }),
    db
      .select({ total: count() })
      .from(releases)
      .where(inArray(releases.workspaceId, targetWsIds)),
  ]);

  // Build workspace map for display
  const wsMap = new Map<string, { name: string; gitConfig: any }>();
  for (const ws of releaseEnabledWorkspaces) {
    wsMap.set(ws.id, {
      name: ws.name,
      gitConfig: ws.gitConfig,
    });
  }

  // Compute attributed task and mission counts from the eager-loaded release-task edges
  const allTaskIds = [...new Set(allReleases.flatMap(r => r.releaseTasks.map(rt => rt.taskId)))];

  const taskMissionRows = allTaskIds.length > 0
    ? await db
        .select({ taskId: tasks.id, missionId: tasks.missionId })
        .from(tasks)
        .where(inArray(tasks.id, allTaskIds))
    : [];
  const taskToMissionId = new Map(taskMissionRows.map(r => [r.taskId, r.missionId]));

  const releaseMetrics = new Map<string, { taskCount: number; missionCount: number }>();
  for (const release of allReleases) {
    const taskIds = release.releaseTasks.map(rt => rt.taskId);
    const missionIds = new Set(taskIds.map(id => taskToMissionId.get(id)).filter(Boolean));
    releaseMetrics.set(release.id, { taskCount: taskIds.length, missionCount: missionIds.size });
  }

  // Resolve the versions of the releases that superseded failed rows.
  const supersededReleaseIds = new Set<string>();
  for (const release of allReleases) {
    const successorId = supersededById(release.failureReason);
    if (successorId) supersededReleaseIds.add(successorId);
  }

  const supersededReleases = supersededReleaseIds.size > 0
    ? await db
        .select({ id: releases.id, version: releases.version })
        .from(releases)
        .where(inArray(releases.id, [...supersededReleaseIds]))
    : [];
  const supersededReleaseMap = new Map(supersededReleases.map(r => [r.id, r.version]));

  // The owner's release flow, for a workspace that cuts frozen candidates and a
  // person who may release it (team owner or admin).
  const canRelease = (await teamIdsWhere({ kind: 'user', userId: user.id }, 'manage_releases')).includes(activeTeamId);
  const composeWorkspace = canRelease
    ? releaseEnabledWorkspaces.find(ws => targetWsIds.includes(ws.id) && releaseCandidatePolicy(ws.releaseConfig as any))
    : undefined;

  return (
    <ReleasesList
      releases={allReleases}
      total={Number(total)}
      workspaces={wsMap}
      metrics={releaseMetrics}
      supersededVersions={supersededReleaseMap}
      composeWorkspaceId={composeWorkspace?.id ?? null}
    />
  );
}
