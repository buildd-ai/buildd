import { db } from '@buildd/core/db';
import { workspaces, githubRepos, releases as releasesTable, releaseTasks, tasks as tasksTable } from '@buildd/core/db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, verifyWorkspaceAccess } from '@/lib/team-access';
import { cookies } from 'next/headers';
import { resolveActiveTeamId } from '@/lib/team-access';

export const dynamic = 'force-dynamic';

const STATE_BADGE: Record<string, { label: string; cls: string }> = {
  healthy: { label: 'Healthy', cls: 'text-status-success border-status-success/30' },
  deploying: { label: 'Deploying', cls: 'text-status-info border-status-info/30' },
  dispatched: { label: 'Dispatched', cls: 'text-status-info border-status-info/30' },
  failed: { label: 'Failed', cls: 'text-status-error border-status-error/30' },
  degraded: { label: 'Degraded', cls: 'text-status-warning border-status-warning/30' },
  pending_external: { label: 'Pending', cls: 'text-text-muted border-border-default' },
};

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface ReleaseRow {
  id: string;
  archetype: string;
  state: string;
  dispatchedAt: Date | null;
  deployedAt: Date | null;
  healthyAt: Date | null;
  commitsAheadAtDispatch: number | null;
  createdAt: Date | null;
  version: string | null;
  previousSha: string | null;
  headSha: string | null;
  triggeredBy: string | null;
  taskCount: number;
  missionCount: number;
}

export default async function ReleasesPage() {
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
          <p className="text-xs text-text-muted">Create a workspace to get started.</p>
        </div>
      </div>
    );
  }

  const cookieStore = await cookies();
  const activeTeamId =
    (await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value)) ?? teamIds[0];

  // Fetch releases for active team's workspaces
  const teamWorkspaces = await db
    .select({ id: workspaces.id, name: workspaces.name, githubRepoId: workspaces.githubRepoId, releaseConfig: workspaces.releaseConfig })
    .from(workspaces)
    .where(eq(workspaces.teamId, activeTeamId));

  if (teamWorkspaces.length === 0) {
    return (
      <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="text-xl font-semibold text-text-primary">Releases</h1>
        </div>
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary mb-1">No workspaces found.</p>
        </div>
      </div>
    );
  }

  // Load all releases across workspaces
  const workspaceIds = teamWorkspaces.map(w => w.id);
  const releaseRows = await db
    .select({
      id: releasesTable.id,
      workspaceId: releasesTable.workspaceId,
      archetype: releasesTable.archetype,
      state: releasesTable.state,
      dispatchedAt: releasesTable.dispatchedAt,
      deployedAt: releasesTable.deployedAt,
      healthyAt: releasesTable.healthyAt,
      commitsAheadAtDispatch: releasesTable.commitsAheadAtDispatch,
      createdAt: releasesTable.createdAt,
      version: releasesTable.version,
      previousSha: releasesTable.previousSha,
      headSha: releasesTable.headSha,
      triggeredBy: releasesTable.triggeredBy,
    })
    .from(releasesTable)
    .where((rel) => {
      return workspaceIds.length === 1
        ? eq(rel.workspaceId, workspaceIds[0]!)
        : rel.workspaceId.inArray(workspaceIds);
    })
    .orderBy(desc(releasesTable.createdAt));

  // Build repo full name map
  const repoMap = new Map<string, string | null>();
  for (const ws of teamWorkspaces) {
    if (ws.githubRepoId) {
      const repo = await db.query.githubRepos.findFirst({
        where: eq(githubRepos.id, ws.githubRepoId),
        columns: { fullName: true },
      });
      repoMap.set(ws.id, repo?.fullName ?? null);
    } else {
      repoMap.set(ws.id, null);
    }
  }

  // Build workspace name map
  const wsNameMap = new Map<string, string>(
    teamWorkspaces.map(w => [w.id, w.name || 'Unnamed'])
  );

  // Load task/mission counts for each release
  const releaseTaskCounts = new Map<string, { taskCount: number; missionCount: number }>();
  if (releaseRows.length > 0) {
    const countResults = await db
      .select({
        releaseId: releaseTasks.releaseId,
        taskCount: sql<number>`count(distinct ${releaseTasks.taskId})::int`,
        missionCount: sql<number>`count(distinct ${tasksTable.missionId})::int`,
      })
      .from(releaseTasks)
      .leftJoin(tasksTable, eq(releaseTasks.taskId, tasksTable.id))
      .groupBy(releaseTasks.releaseId);

    countResults.forEach((row) => {
      releaseTaskCounts.set(row.releaseId, {
        taskCount: row.taskCount,
        missionCount: row.missionCount,
      });
    });
  }

  // Build commit range URLs
  const commitRangeUrls = new Map<string, string | null>();
  for (const rel of releaseRows) {
    const repoFullName = repoMap.get(rel.workspaceId);
    const url = repoFullName && rel.previousSha && rel.headSha
      ? `https://github.com/${repoFullName}/compare/${rel.previousSha}...${rel.headSha}`
      : null;
    commitRangeUrls.set(rel.id, url);
  }

  // Empty state check
  const hasReleases = releaseRows.length > 0;

  if (!hasReleases) {
    return (
      <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="text-xl font-semibold text-text-primary">Releases</h1>
          <span className="text-xs text-text-secondary font-light">0 releases</span>
        </div>
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary mb-1">No releases yet.</p>
          <p className="text-xs text-text-muted">Create and deploy your first release from a mission.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Releases</h1>
        <span className="text-xs text-text-secondary font-light">{releaseRows.length} total</span>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-border-default">
            <tr className="bg-[var(--chrome-header)]">
              <th className="px-4 py-2.5 text-left font-medium text-text-secondary text-[12px]">State</th>
              <th className="px-4 py-2.5 text-left font-medium text-text-secondary text-[12px]">Archetype</th>
              <th className="px-4 py-2.5 text-left font-medium text-text-secondary text-[12px]">Workspace</th>
              <th className="px-4 py-2.5 text-left font-medium text-text-secondary text-[12px]">Dispatched</th>
              <th className="px-4 py-2.5 text-left font-medium text-text-secondary text-[12px]">Deployed</th>
              <th className="px-4 py-2.5 text-left font-medium text-text-secondary text-[12px]">Commits</th>
              <th className="px-4 py-2.5 text-left font-medium text-text-secondary text-[12px]">Tasks</th>
              <th className="px-4 py-2.5 text-left font-medium text-text-secondary text-[12px]">Missions</th>
            </tr>
          </thead>
          <tbody>
            {releaseRows.map((release) => {
              const stateBadge = STATE_BADGE[release.state] ?? { label: release.state, cls: 'text-text-muted border-border-default' };
              const repoUrl = commitRangeUrls.get(release.id);
              const wsName = wsNameMap.get(release.workspaceId) || 'Unknown';
              const counts = releaseTaskCounts.get(release.id) ?? { taskCount: 0, missionCount: 0 };

              return (
                <tr key={release.id} className="border-b border-border-default hover:bg-[var(--chrome-hover)] transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/app/releases/${release.id}`} className="contents">
                      <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 border ${stateBadge.cls} cursor-pointer hover:opacity-80`}>
                        {stateBadge.label}
                      </span>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[11px] font-mono text-text-secondary capitalize">{release.archetype || '—'}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/app/settings/workspace/${release.workspaceId}`} className="text-[11px] text-text-secondary hover:text-text-primary transition-colors">
                      {wsName}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[11px] font-mono text-text-muted" title={release.dispatchedAt ? String(release.dispatchedAt) : ''}>
                      {release.dispatchedAt ? relativeTime(String(release.dispatchedAt)) : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[11px] font-mono text-text-muted" title={release.deployedAt ? String(release.deployedAt) : ''}>
                      {release.deployedAt ? relativeTime(String(release.deployedAt)) : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {release.commitsAheadAtDispatch !== null ? (
                      repoUrl ? (
                        <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-mono text-text-muted hover:text-text-secondary transition-colors">
                          {release.commitsAheadAtDispatch} commits →
                        </a>
                      ) : (
                        <span className="text-[11px] font-mono text-text-muted">{release.commitsAheadAtDispatch} commits</span>
                      )
                    ) : (
                      <span className="text-[11px] font-mono text-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/app/releases/${release.id}`} className="text-[11px] text-text-muted hover:text-text-secondary transition-colors">
                      {counts.taskCount}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/app/releases/${release.id}`} className="text-[11px] text-text-muted hover:text-text-secondary transition-colors">
                      {counts.missionCount}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
