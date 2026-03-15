import { db } from '@buildd/core/db';
import { objectives } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';

export const dynamic = 'force-dynamic';

type MissionType = 'build' | 'watch' | 'brief';

function classifyMission(obj: {
  cronExpression: string | null;
  isHeartbeat: boolean;
}): MissionType {
  if (!obj.cronExpression) return 'build';
  if (obj.isHeartbeat) return 'watch';
  return 'brief';
}

function timeAgo(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-text-muted',
  queued: 'bg-status-info',
  running: 'bg-status-running animate-status-pulse',
  waiting_input: 'bg-status-warning animate-status-pulse',
  completed: 'bg-status-success',
  failed: 'bg-status-error',
};

const TYPE_BADGE: Record<MissionType, { label: string; classes: string }> = {
  build: { label: 'BUILD', classes: 'type-label-build bg-status-success/10' },
  watch: { label: 'WATCH', classes: 'type-label-watch bg-status-warning/10' },
  brief: { label: 'BRIEF', classes: 'type-label-brief bg-accent-soft' },
};

export default async function MissionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);

  const objective = await db.query.objectives.findFirst({
    where: eq(objectives.id, id),
    with: {
      workspace: { columns: { id: true, name: true } },
      tasks: {
        columns: {
          id: true,
          title: true,
          status: true,
          priority: true,
          createdAt: true,
          result: true,
          mode: true,
        },
        orderBy: (t: any, { desc }: any) => [desc(t.createdAt)],
        with: {
          workers: {
            columns: {
              id: true,
              status: true,
              branch: true,
              prUrl: true,
              prNumber: true,
              costUsd: true,
              turns: true,
              completedAt: true,
              startedAt: true,
              currentAction: true,
              commitCount: true,
              filesChanged: true,
            },
            orderBy: (w: any, { desc }: any) => [desc(w.startedAt)],
            limit: 3,
            with: {
              artifacts: {
                columns: { id: true, type: true, title: true, key: true, shareToken: true },
                limit: 5,
              },
            },
          },
        },
      },
      schedule: true,
    },
  });

  if (!objective || !teamIds.includes(objective.teamId)) {
    notFound();
  }

  const missionType = classifyMission(objective);
  const badge = TYPE_BADGE[missionType];

  const totalTasks = objective.tasks?.length || 0;
  const completedTasks = objective.tasks?.filter((t) => t.status === 'completed').length || 0;
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const activeTasks = objective.tasks?.filter(
    (t) => !['completed', 'failed'].includes(t.status)
  ) || [];
  const doneTasks = objective.tasks?.filter(
    (t) => ['completed', 'failed'].includes(t.status)
  ) || [];

  // Collect all artifacts
  const allArtifacts = objective.tasks?.flatMap((t) =>
    t.workers?.flatMap((w) =>
      (w.artifacts || []).map((a) => ({ ...a, taskTitle: t.title, workerStatus: w.status }))
    ) || []
  ) || [];

  // Collect recent worker activity
  const recentActivity = objective.tasks
    ?.flatMap((t) =>
      (t.workers || []).map((w) => ({
        taskId: t.id,
        taskTitle: t.title,
        workerId: w.id,
        status: w.status,
        currentAction: w.currentAction,
        prUrl: w.prUrl,
        prNumber: w.prNumber,
        branch: w.branch,
        turns: w.turns,
        costUsd: w.costUsd,
        commitCount: w.commitCount,
        filesChanged: w.filesChanged,
        startedAt: w.startedAt,
        completedAt: w.completedAt,
      }))
    )
    .sort((a, b) => {
      const aTime = a.completedAt || a.startedAt;
      const bTime = b.completedAt || b.startedAt;
      if (!bTime) return -1;
      if (!aTime) return 1;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    })
    .slice(0, 8) || [];

  // Connected MCP tools — unique tool names from worker metadata
  const mcpTools = new Set<string>();
  objective.tasks?.forEach((t) =>
    t.workers?.forEach((w) => {
      // Worker tool calls not stored yet — placeholder for future
    })
  );

  return (
    <div className="px-7 md:px-10 pt-5 md:pt-8 pb-12 max-w-3xl">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-[12px] text-text-muted mb-5">
        <Link href="/app/missions" className="hover:text-text-secondary transition-colors">
          Missions
        </Link>
        <span>/</span>
        <span className="text-text-secondary truncate">{objective.title}</span>
      </div>

      {/* ── Status Block ── */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h1 className="text-xl font-semibold text-text-primary font-sans">
            {objective.title}
          </h1>
          <span className={`type-label px-2 py-0.5 rounded-full ${badge.classes}`}>
            {badge.label}
          </span>
        </div>

        {objective.description && (
          <p className="text-[13px] text-text-desc leading-relaxed mb-4">
            {objective.description}
          </p>
        )}

        {/* Progress (build missions) */}
        {missionType === 'build' && totalTasks > 0 && (
          <div className="card p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] text-text-secondary">Progress</span>
              <span className="font-display text-lg text-status-success tabular-nums">
                {progress}%
              </span>
            </div>
            <div className="h-[3px] rounded-full bg-[rgba(255,245,230,0.06)] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${progress}%`,
                  background: 'linear-gradient(90deg, var(--status-success), #7ad4aa)',
                }}
              />
            </div>
            <div className="text-[11px] text-text-muted mt-1.5">
              {completedTasks} of {totalTasks} tasks complete
            </div>
          </div>
        )}

        {/* Schedule info */}
        {objective.cronExpression && (
          <div className="flex items-center gap-2 text-[12px] text-text-muted mb-4">
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <code className="font-mono text-[11px] text-text-secondary">
              {objective.cronExpression}
            </code>
            {(objective.schedule as any)?.nextRunAt && (
              <span>
                &middot; Next: {new Date((objective.schedule as any).nextRunAt).toLocaleString()}
              </span>
            )}
          </div>
        )}

        {/* Workspace link */}
        {objective.workspace && (
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <Link
              href={`/app/workspaces/${objective.workspace.id}`}
              className="text-accent-text hover:underline"
            >
              {objective.workspace.name}
            </Link>
          </div>
        )}
      </div>

      {/* ── Connected Services ── */}
      {mcpTools.size > 0 && (
        <div className="mb-6">
          <h2 className="section-label mb-3">Connected Services</h2>
          <div className="flex flex-wrap gap-2">
            {Array.from(mcpTools).map((tool) => (
              <span
                key={tool}
                className="px-2.5 py-1 rounded-full bg-surface-3 border border-card-border text-[11px] text-text-secondary font-mono"
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Task Tree ── */}
      {activeTasks.length > 0 && (
        <div className="mb-6">
          <h2 className="section-label mb-3">Active Tasks ({activeTasks.length})</h2>
          <div className="space-y-1.5">
            {activeTasks.map((task) => {
              const latestWorker = task.workers?.[0];
              return (
                <Link
                  key={task.id}
                  href={`/app/tasks/${task.id}`}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-card-hover transition-colors group"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[task.status] || 'bg-text-muted'}`}
                  />
                  <span className="flex-1 text-[13px] text-text-primary truncate group-hover:text-accent-text transition-colors">
                    {task.title}
                  </span>
                  {latestWorker?.currentAction && (
                    <span className="hidden md:block text-[11px] text-text-muted truncate max-w-[200px]">
                      {latestWorker.currentAction}
                    </span>
                  )}
                  <span className="text-[11px] text-text-muted shrink-0">
                    {timeAgo(task.createdAt)}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {doneTasks.length > 0 && (
        <div className="mb-6">
          <h2 className="section-label mb-3">Completed ({doneTasks.length})</h2>
          <div className="space-y-1.5">
            {doneTasks.map((task) => {
              const latestWorker = task.workers?.[0];
              return (
                <Link
                  key={task.id}
                  href={`/app/tasks/${task.id}`}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-card-hover transition-colors opacity-70 group"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[task.status] || 'bg-text-muted'}`}
                  />
                  <span className="flex-1 text-[13px] text-text-primary truncate">
                    {task.title}
                  </span>
                  {latestWorker?.prUrl && (
                    <span className="text-[11px] text-accent-text shrink-0">
                      PR #{latestWorker.prNumber}
                    </span>
                  )}
                  <span className="text-[11px] text-text-muted shrink-0">
                    {timeAgo(task.createdAt)}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Activity Feed ── */}
      {recentActivity.length > 0 && (
        <div className="mb-6">
          <h2 className="section-label mb-3">Recent Activity</h2>
          <div className="space-y-2">
            {recentActivity.map((w) => (
              <div
                key={w.workerId}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-card border border-card-border"
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[w.status] || 'bg-text-muted'}`}
                />
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/app/tasks/${w.taskId}`}
                    className="text-[13px] text-text-primary hover:text-accent-text truncate block transition-colors"
                  >
                    {w.taskTitle}
                  </Link>
                  {w.currentAction && (
                    <p className="text-[11px] text-text-muted truncate mt-0.5">
                      {w.currentAction}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2.5 text-[11px] text-text-muted shrink-0">
                  {w.commitCount ? (
                    <span>{w.commitCount} commit{w.commitCount !== 1 ? 's' : ''}</span>
                  ) : null}
                  {w.prUrl && (
                    <a
                      href={w.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent-text hover:underline"
                    >
                      PR #{w.prNumber}
                    </a>
                  )}
                  {(w.completedAt || w.startedAt) && (
                    <span>{timeAgo(w.completedAt || w.startedAt!)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Artifacts ── */}
      {allArtifacts.length > 0 && (
        <div className="mb-6">
          <h2 className="section-label mb-3">Artifacts ({allArtifacts.length})</h2>
          <div className="space-y-1.5">
            {allArtifacts.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-card border border-card-border"
              >
                <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] text-text-primary truncate block">
                    {a.title || a.key || 'Untitled'}
                  </span>
                  <span className="text-[11px] text-text-muted">
                    {a.type} &middot; {a.taskTitle}
                  </span>
                </div>
                {a.shareToken && (
                  <a
                    href={`/share/${a.shareToken}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-accent-text hover:underline shrink-0"
                  >
                    View
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Quick Task Input (placeholder) ── */}
      <div className="mt-8">
        <h2 className="section-label mb-3">Quick Task</h2>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Add a task to this mission..."
            disabled
            className="flex-1 px-3 py-2 rounded-lg bg-surface-3 border border-card-border text-[13px] text-text-primary placeholder:text-text-muted disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            disabled
            className="px-4 py-2 rounded-lg bg-accent/20 text-accent-text text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
        <p className="text-[11px] text-text-muted mt-1.5">
          Coming soon — quick-add tasks to this mission.
        </p>
      </div>
    </div>
  );
}
