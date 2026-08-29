import { db } from '@buildd/core/db';
import { releases, releaseTasks, tasks, missions, workspaces, githubRepos } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';

export const dynamic = 'force-dynamic';

const STATE_BADGE: Record<string, { label: string; cls: string }> = {
  healthy: { label: 'Healthy', cls: 'text-status-success border-status-success/30' },
  deploying: { label: 'Deploying', cls: 'text-status-info border-status-info/30' },
  dispatched: { label: 'Dispatched', cls: 'text-status-info border-status-info/30' },
  failed: { label: 'Failed', cls: 'text-status-error border-status-error/30' },
  degraded: { label: 'Degraded', cls: 'text-status-warning border-status-warning/30' },
  pending_external: { label: 'Pending', cls: 'text-text-muted border-border-default' },
};

const CI_BADGE: Record<string, { label: string; cls: string }> = {
  passing: { label: 'CI Passing', cls: 'text-status-success border-status-success/30' },
  failing: { label: 'CI Failing', cls: 'text-status-error border-status-error/30' },
  pending: { label: 'CI Pending', cls: 'text-status-warning border-status-warning/30' },
};

const TASK_STATUS_CLS: Record<string, string> = {
  completed: 'text-status-success',
  failed: 'text-status-error',
  in_progress: 'text-status-info',
  pending: 'text-text-muted',
  assigned: 'text-status-info',
  cancelled: 'text-text-muted',
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function ReleaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);

  const release = await db.query.releases.findFirst({
    where: eq(releases.id, id),
  });

  if (!release) notFound();

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, release.workspaceId),
    columns: { id: true, name: true, teamId: true, githubRepoId: true },
  });

  if (!ws || !teamIds.includes(ws.teamId)) notFound();

  let repoFullName: string | null = null;
  if (ws.githubRepoId) {
    const repoRow = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.id, ws.githubRepoId),
      columns: { fullName: true },
    });
    repoFullName = repoRow?.fullName ?? null;
  }

  const commitRangeUrl =
    repoFullName && release.previousSha && release.headSha
      ? `https://github.com/${repoFullName}/compare/${release.previousSha}...${release.headSha}`
      : null;

  const edges = await db
    .select({
      taskId: releaseTasks.taskId,
      prNumber: releaseTasks.prNumber,
      commitSha: releaseTasks.commitSha,
      taskTitle: tasks.title,
      taskStatus: tasks.status,
      missionId: tasks.missionId,
    })
    .from(releaseTasks)
    .leftJoin(tasks, eq(releaseTasks.taskId, tasks.id))
    .where(eq(releaseTasks.releaseId, id));

  const missionIds = [...new Set(edges.map((e) => e.missionId).filter(Boolean) as string[])];
  const missionRows =
    missionIds.length > 0
      ? await db
          .select({ id: missions.id, title: missions.title })
          .from(missions)
          .where(inArray(missions.id, missionIds))
      : [];

  const stateBadge = STATE_BADGE[release.state] ?? { label: release.state, cls: 'text-text-muted border-border-default' };
  const ciBadge = release.ciStateAtDispatch ? CI_BADGE[release.ciStateAtDispatch] : null;

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 max-w-3xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-[11px] font-mono text-text-muted mb-4">
        <Link href="/app/missions" className="hover:text-text-secondary transition-colors">Missions</Link>
        <span>/</span>
        <Link href={`/app/settings/workspace/${ws.id}`} className="hover:text-text-secondary transition-colors">
          {ws.name}
        </Link>
        <span>/</span>
        <span className="text-text-primary">Release</span>
      </div>

      {/* Header card */}
      <div className="card p-5 mb-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 border uppercase tracking-wide ${stateBadge.cls}`}>
                {stateBadge.label}
              </span>
              {release.archetype && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 border border-border-default text-text-muted uppercase tracking-wide">
                  {release.archetype}
                </span>
              )}
              {release.version && (
                <span className="text-[11px] font-mono text-text-secondary">{release.version}</span>
              )}
            </div>
            <h1 className="text-lg font-semibold text-text-primary">{ws.name}</h1>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
          {release.dispatchedAt && (
            <div>
              <span className="text-text-muted font-mono">Dispatched</span>
              <span className="ml-2 text-text-secondary" title={String(release.dispatchedAt)}>
                {relativeTime(String(release.dispatchedAt))}
              </span>
            </div>
          )}
          {release.deployedAt && (
            <div>
              <span className="text-text-muted font-mono">Deployed</span>
              <span className="ml-2 text-text-secondary" title={String(release.deployedAt)}>
                {relativeTime(String(release.deployedAt))}
              </span>
            </div>
          )}
          {release.healthyAt && (
            <div>
              <span className="text-text-muted font-mono">Healthy</span>
              <span className="ml-2 text-text-secondary" title={String(release.healthyAt)}>
                {relativeTime(String(release.healthyAt))}
              </span>
            </div>
          )}
          {release.triggeredBy && (
            <div>
              <span className="text-text-muted font-mono">Triggered by</span>
              <span className="ml-2 text-text-secondary capitalize">{release.triggeredBy}</span>
            </div>
          )}
        </div>

        {release.failureReason && (
          <div className="mt-3 px-3 py-2 bg-status-error/5 border border-status-error/20 text-[11px] text-status-error font-mono">
            {release.failureReason}
          </div>
        )}
      </div>

      {/* Commit range */}
      {(commitRangeUrl || release.commitsAheadAtDispatch != null) && (
        <div className="card p-4 mb-4">
          <div className="text-[11px] font-mono text-text-muted uppercase tracking-wide mb-2">Commit Range</div>
          <div className="flex items-center gap-3 flex-wrap">
            {release.commitsAheadAtDispatch != null && (
              <span className="text-[12px] text-text-secondary font-mono">
                {release.commitsAheadAtDispatch} commit{release.commitsAheadAtDispatch !== 1 ? 's' : ''} ahead at dispatch
              </span>
            )}
            {commitRangeUrl && (
              <a
                href={commitRangeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-mono text-primary hover:underline"
              >
                {release.previousSha?.slice(0, 7)}...{release.headSha?.slice(0, 7)} →
              </a>
            )}
            {!commitRangeUrl && release.headSha && (
              <span className="text-[11px] font-mono text-text-secondary">{release.headSha.slice(0, 7)}</span>
            )}
          </div>
        </div>
      )}

      {/* CI + workflow run */}
      {(ciBadge || release.runUrl || release.deployUrl) && (
        <div className="card p-4 mb-4">
          <div className="text-[11px] font-mono text-text-muted uppercase tracking-wide mb-2">CI & Deploy</div>
          <div className="flex flex-wrap gap-3 items-center">
            {ciBadge && (
              <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 border ${ciBadge.cls}`}>
                {ciBadge.label}
              </span>
            )}
            {release.runUrl && (
              <a
                href={release.runUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-mono text-primary hover:underline"
              >
                Workflow run →
              </a>
            )}
            {release.deployUrl && (
              <a
                href={release.deployUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-mono text-primary hover:underline"
              >
                Deploy URL →
              </a>
            )}
          </div>
        </div>
      )}

      {/* Attributed tasks */}
      {edges.length > 0 && (
        <div className="card p-4 mb-4">
          <div className="text-[11px] font-mono text-text-muted uppercase tracking-wide mb-3">
            Attributed Tasks ({edges.length})
          </div>
          <div className="space-y-2">
            {edges.map((edge) => (
              <div key={edge.taskId} className="flex items-center justify-between gap-3 text-[12px]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`shrink-0 font-mono text-[10px] ${TASK_STATUS_CLS[edge.taskStatus ?? ''] ?? 'text-text-muted'}`}>
                    {edge.taskStatus ?? '—'}
                  </span>
                  <Link
                    href={`/app/tasks/${edge.taskId}`}
                    className="text-text-primary hover:text-accent-text transition-colors truncate"
                  >
                    {edge.taskTitle ?? edge.taskId.slice(0, 8)}
                  </Link>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {edge.prNumber && (
                    <span className="font-mono text-[10px] text-text-muted">PR #{edge.prNumber}</span>
                  )}
                  {edge.commitSha && (
                    <span className="font-mono text-[10px] text-text-muted">{edge.commitSha.slice(0, 7)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Attributed missions */}
      {missionRows.length > 0 && (
        <div className="card p-4 mb-4">
          <div className="text-[11px] font-mono text-text-muted uppercase tracking-wide mb-3">
            Attributed Missions ({missionRows.length})
          </div>
          <div className="space-y-2">
            {missionRows.map((m) => (
              <Link
                key={m.id}
                href={`/app/missions/${m.id}`}
                className="block text-[12px] text-text-primary hover:text-accent-text transition-colors"
              >
                {m.title}
              </Link>
            ))}
          </div>
        </div>
      )}

      {edges.length === 0 && missionRows.length === 0 && (
        <div className="card p-6 text-center">
          <p className="text-sm text-text-secondary">No tasks attributed to this release yet.</p>
        </div>
      )}
    </div>
  );
}
