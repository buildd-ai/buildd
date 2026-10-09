import { db } from '@buildd/core/db';
import { releases, tasks, workspaces } from '@buildd/core/db/schema';
import { count, eq, inArray, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import Card from '@/components/ui/Card';
import Eyebrow from '@/components/ui/Eyebrow';
import { ReleaseRow } from './ReleaseRow';
import { isSupersededRelease, pickNextRelease, releaseCountLine, supersededById } from './release-display';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/** How many releases the list shows; the count line says when there are more. */
const LIST_LIMIT = 100;

/** The page header: the shell's mobile header already says "Releases", so the h1 shows from md up only. */
function ReleasesHeader({ countLine }: { countLine?: string }) {
  return (
    <div className="mb-5">
      <h1 data-testid="releases-headline" className="sr-only md:not-sr-only text-xl font-semibold text-text-primary">Releases</h1>
      {countLine && <p data-testid="releases-count" className="font-mono text-meta text-text-muted md:mt-1">{countLine}</p>}
    </div>
  );
}

export default async function ReleasesPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  const { workspace: wsFilter } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return (
      <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
        <ReleasesHeader />
        <p className="text-body text-text-secondary">
          No team yet. <Link href="/app/settings/team/new" className="text-text-primary underline underline-offset-2">Create a team</Link> to track releases.
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

  // The workspace name is the row's context only when the list spans several;
  // with one, the switcher already names it.
  const multiWorkspace = new Set(allReleases.map(r => r.workspaceId)).size > 1;

  function renderRow(release: typeof allReleases[number], bare = false) {
    const ws = wsMap.get(release.workspaceId);
    const gitConfig = ws?.gitConfig as any;
    const commitRangeUrl =
      gitConfig?.fullName && release.previousSha && release.headSha
        ? `https://github.com/${gitConfig.fullName}/compare/${release.previousSha}...${release.headSha}`
        : null;
    const successorId = isSupersededRelease(release) ? supersededById(release.failureReason) : null;
    const resolved = successorId != null && supersededReleaseMap.has(successorId);
    return (
      <ReleaseRow
        key={release.id}
        release={release}
        workspaceName={multiWorkspace ? ws?.name ?? null : null}
        commitRangeUrl={commitRangeUrl}
        metrics={releaseMetrics.get(release.id) ?? { taskCount: 0, missionCount: 0 }}
        supersededByVersion={resolved ? supersededReleaseMap.get(successorId) : null}
        supersededByReleaseId={resolved ? successorId : null}
        bare={bare}
      />
    );
  }

  const next = pickNextRelease(allReleases);
  const history = next ? allReleases.filter(r => r.id !== next.id) : allReleases;

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 pb-10 max-w-3xl">
      <ReleasesHeader countLine={allReleases.length > 0 ? releaseCountLine(allReleases.length, Number(total)) : undefined} />

      {allReleases.length === 0 ? (
        <p className="text-body text-text-secondary">No releases yet.</p>
      ) : (
        <>
          {/* The next release: the one L2 card on the page, everything below is
              L1 history. This is the future home of the release candidate
              (choose missions → RC → review CI → release). */}
          {next && (
            <Card data-testid="next-release" className="mb-6 flex flex-col gap-2">
              <Eyebrow tone="muted">Next release</Eyebrow>
              {renderRow(next, true)}
            </Card>
          )}
          <div className="border-t border-border-default">
            {history.map(release => renderRow(release))}
          </div>
        </>
      )}
    </div>
  );
}
