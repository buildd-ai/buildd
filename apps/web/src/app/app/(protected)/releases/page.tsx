import { db } from '@buildd/core/db';
import { releases, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, inArray, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';
import { ReleaseRow } from './ReleaseRow';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const STATE_BADGE: Record<string, { label: string; cls: string }> = {
  healthy: { label: 'Healthy', cls: 'text-status-success border-status-success/30' },
  deploying: { label: 'Deploying', cls: 'text-status-info border-status-info/30' },
  dispatched: { label: 'Dispatched', cls: 'text-status-info border-status-info/30' },
  failed: { label: 'Failed', cls: 'text-status-error border-status-error/30' },
  degraded: { label: 'Degraded', cls: 'text-status-warning border-status-warning/30' },
  pending_external: { label: 'Pending', cls: 'text-text-muted border-border-default' },
};

const ARCHETYPE_BADGE: Record<string, { label: string; cls: string }> = {
  gated: { label: 'Gated', cls: 'text-blue-600 border-blue-200' },
  continuous: { label: 'Continuous', cls: 'text-green-600 border-green-200' },
  store: { label: 'Store', cls: 'text-purple-600 border-purple-200' },
  package: { label: 'Package', cls: 'text-orange-600 border-orange-200' },
  none: { label: 'None', cls: 'text-text-muted border-border-default' },
};

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
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="text-xl font-semibold text-text-primary">Releases</h1>
        </div>
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary mb-1">No team found.</p>
          <p className="text-xs text-text-muted"><Link href="/app/teams/new" className="text-primary hover:underline">Create a team</Link> to track releases.</p>
        </div>
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
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="text-xl font-semibold text-text-primary">Releases</h1>
          {releaseEnabledWorkspaces.length > 1 && <WorkspaceFilter workspaces={releaseEnabledWorkspaces} selectedId={wsFilter} />}
        </div>
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary mb-1">No releases.</p>
          <p className="text-xs text-text-muted">Releases will appear here when workspaces are configured and releases are dispatched.</p>
        </div>
      </div>
    );
  }

  // Fetch releases for the filtered workspaces, eager-loading task attribution
  const allReleases = await db.query.releases.findMany({
    where: inArray(releases.workspaceId, targetWsIds),
    orderBy: [desc(releases.createdAt)],
    limit: 100,
    with: { releaseTasks: { columns: { taskId: true } } },
  });

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

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Releases</h1>
        <div className="flex items-center gap-4">
          <span className="text-xs text-text-secondary font-light">{allReleases.length} release{allReleases.length !== 1 ? 's' : ''}</span>
          {releaseEnabledWorkspaces.length > 1 && <WorkspaceFilter workspaces={releaseEnabledWorkspaces} selectedId={wsFilter} />}
        </div>
      </div>

      {allReleases.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary mb-1">No releases found.</p>
          <p className="text-xs text-text-muted">Releases will appear here when they are dispatched.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {allReleases.map((release) => {
            const ws = wsMap.get(release.workspaceId);
            const stateBadge = STATE_BADGE[release.state] ?? { label: release.state, cls: 'text-text-muted border-border-default' };
            const archetypeBadge = ARCHETYPE_BADGE[release.archetype ?? 'none'] ?? { label: release.archetype, cls: 'text-text-muted border-border-default' };
            const metrics = releaseMetrics.get(release.id) ?? { taskCount: 0, missionCount: 0 };

            const gitConfig = ws?.gitConfig as any;
            const commitRangeUrl =
              gitConfig?.fullName && release.previousSha && release.headSha
                ? `https://github.com/${gitConfig.fullName}/compare/${release.previousSha}...${release.headSha}`
                : null;

            return (
              <ReleaseRow
                key={release.id}
                release={release as any}
                workspaceName={ws?.name ?? release.workspaceId}
                commitRangeUrl={commitRangeUrl}
                metrics={metrics}
                stateBadge={stateBadge}
                archetypeBadge={archetypeBadge}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
