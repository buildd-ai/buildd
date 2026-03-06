import { db } from '@buildd/core/db';
import { objectives } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import StatusBadge from '@/components/StatusBadge';
import ObjectiveActions from './ObjectiveActions';

export const dynamic = 'force-dynamic';

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-status-success/15 text-status-success',
  paused: 'bg-status-warning/15 text-status-warning',
  completed: 'bg-primary/15 text-primary',
  archived: 'bg-surface-3 text-text-muted',
};

const PRIORITY_LABELS: Record<number, string> = {
  0: 'Low',
  5: 'Medium',
  10: 'High',
};

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

export default async function ObjectiveDetailPage({
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
        columns: { id: true, title: true, status: true, priority: true, createdAt: true, result: true },
        orderBy: (tasks, { desc }) => [desc(tasks.createdAt)],
        with: {
          workers: {
            columns: {
              id: true, status: true, branch: true, prUrl: true, prNumber: true,
              costUsd: true, turns: true, completedAt: true, startedAt: true,
              currentAction: true, commitCount: true, filesChanged: true,
            },
            orderBy: (workers, { desc }) => [desc(workers.startedAt)],
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
      subObjectives: { columns: { id: true, title: true, status: true } },
      schedule: true,
    },
  });

  if (!objective || !teamIds.includes(objective.teamId)) {
    notFound();
  }

  const totalTasks = objective.tasks?.length || 0;
  const completedTasks = objective.tasks?.filter(t => t.status === 'completed').length || 0;
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const activeTasks = objective.tasks?.filter(t => !['completed', 'failed'].includes(t.status)) || [];
  const doneTasks = objective.tasks?.filter(t => ['completed', 'failed'].includes(t.status)) || [];

  // Collect all artifacts across all workers
  const allArtifacts = objective.tasks?.flatMap(t =>
    t.workers?.flatMap(w =>
      (w.artifacts || []).map(a => ({ ...a, taskTitle: t.title, workerStatus: w.status }))
    ) || []
  ) || [];

  // Collect recent worker activity across all tasks
  const recentActivity = objective.tasks
    ?.flatMap(t =>
      (t.workers || []).map(w => ({
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

  return (
    <div className="max-w-4xl mx-auto p-6">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-sm text-text-secondary mb-4">
        <Link href="/app/objectives" className="hover:text-text-primary">
          Objectives
        </Link>
        <span>/</span>
        <span className="text-text-primary truncate">{objective.title}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold text-text-primary truncate">{objective.title}</h1>
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[objective.status] || ''}`}>
              {objective.status}
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm text-text-secondary">
            {objective.workspace && (
              <Link href={`/app/workspaces/${objective.workspace.id}`} className="text-primary hover:underline">
                {objective.workspace.name}
              </Link>
            )}
            {objective.priority > 0 && (
              <span>{PRIORITY_LABELS[objective.priority] || `P${objective.priority}`} priority</span>
            )}
          </div>
        </div>
        <ObjectiveActions objectiveId={objective.id} status={objective.status} />
      </div>

      {/* Progress */}
      {totalTasks > 0 && (
        <div className="mb-6 p-4 bg-surface-2 rounded-lg border border-border-default">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-text-primary">Progress</span>
            <span className="text-sm text-text-secondary">{completedTasks}/{totalTasks} tasks</span>
          </div>
          <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="text-right mt-1 text-xs text-text-muted">{progress}%</div>
        </div>
      )}

      {/* Description */}
      {objective.description && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-2">Description</h2>
          <p className="text-text-primary whitespace-pre-wrap">{objective.description}</p>
        </div>
      )}

      {/* Schedule */}
      {objective.cronExpression && (
        <div className="mb-6 p-3 bg-surface-2 rounded-lg border border-border-default">
          <div className="flex items-center gap-2 text-sm">
            <svg className="w-4 h-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-text-secondary">Schedule:</span>
            <code className="text-xs bg-surface-3 px-1.5 py-0.5 rounded">{objective.cronExpression}</code>
            {objective.schedule?.nextRunAt && (
              <span className="text-text-muted">
                Next: {new Date(objective.schedule.nextRunAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Recent Activity */}
      {recentActivity.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Recent Activity
          </h2>
          <div className="space-y-2">
            {recentActivity.map(w => (
              <div
                key={w.workerId}
                className="flex items-center gap-3 p-3 bg-surface-2 border border-border-default rounded-lg text-sm"
              >
                <StatusBadge status={w.status} />
                <div className="flex-1 min-w-0">
                  <Link href={`/app/tasks/${w.taskId}`} className="text-text-primary hover:text-primary truncate block">
                    {w.taskTitle}
                  </Link>
                  {w.currentAction && (
                    <p className="text-xs text-text-muted truncate mt-0.5">{w.currentAction}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-text-muted shrink-0">
                  {w.commitCount ? (
                    <span title={`${w.filesChanged || 0} files changed`}>
                      {w.commitCount} commit{w.commitCount !== 1 ? 's' : ''}
                    </span>
                  ) : null}
                  {w.prUrl && (
                    <a
                      href={w.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                      onClick={e => e.stopPropagation()}
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

      {/* Active Tasks */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Active Tasks ({activeTasks.length})
        </h2>
        {activeTasks.length === 0 ? (
          <p className="text-sm text-text-muted">No active tasks.</p>
        ) : (
          <div className="space-y-2">
            {activeTasks.map(task => {
              const latestWorker = task.workers?.[0];
              return (
                <Link
                  key={task.id}
                  href={`/app/tasks/${task.id}`}
                  className="block p-3 bg-surface-2 border border-border-default rounded-lg hover:border-primary/30 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <StatusBadge status={task.status} />
                    <span className="flex-1 text-sm text-text-primary truncate">{task.title}</span>
                    <span className="text-xs text-text-muted">P{task.priority}</span>
                  </div>
                  {latestWorker && (
                    <div className="flex items-center gap-3 mt-2 ml-[calc(2.5rem)] text-xs text-text-muted">
                      {latestWorker.currentAction && (
                        <span className="truncate flex-1">{latestWorker.currentAction}</span>
                      )}
                      {latestWorker.prUrl && (
                        <a
                          href={latestWorker.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline shrink-0"
                          onClick={e => e.stopPropagation()}
                        >
                          PR #{latestWorker.prNumber}
                        </a>
                      )}
                      {latestWorker.turns > 0 && (
                        <span className="shrink-0">{latestWorker.turns} turns</span>
                      )}
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Completed Tasks */}
      {doneTasks.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Completed Tasks ({doneTasks.length})
          </h2>
          <div className="space-y-2">
            {doneTasks.map(task => {
              const latestWorker = task.workers?.[0];
              return (
                <Link
                  key={task.id}
                  href={`/app/tasks/${task.id}`}
                  className="block p-3 bg-surface-2 border border-border-default rounded-lg hover:border-primary/30 transition-colors opacity-70"
                >
                  <div className="flex items-center gap-3">
                    <StatusBadge status={task.status} />
                    <span className="flex-1 text-sm text-text-primary truncate">{task.title}</span>
                    {latestWorker?.prUrl && (
                      <a
                        href={latestWorker.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline shrink-0"
                        onClick={e => e.stopPropagation()}
                      >
                        PR #{latestWorker.prNumber}
                      </a>
                    )}
                  </div>
                  {task.result && (task.result as any).summary && (
                    <p className="text-xs text-text-muted mt-1.5 ml-[calc(2.5rem)] line-clamp-2">
                      {(task.result as any).summary}
                    </p>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Artifacts */}
      {allArtifacts.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Artifacts ({allArtifacts.length})
          </h2>
          <div className="space-y-2">
            {allArtifacts.map(a => (
              <div
                key={a.id}
                className="flex items-center gap-3 p-3 bg-surface-2 border border-border-default rounded-lg"
              >
                <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-text-primary truncate block">
                    {a.title || a.key || 'Untitled'}
                  </span>
                  <span className="text-xs text-text-muted">{a.type} &middot; {a.taskTitle}</span>
                </div>
                {a.shareToken && (
                  <a
                    href={`/share/${a.shareToken}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline shrink-0"
                  >
                    View
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sub-objectives */}
      {objective.subObjectives && objective.subObjectives.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Sub-objectives
          </h2>
          <div className="space-y-2">
            {objective.subObjectives.map(sub => (
              <Link
                key={sub.id}
                href={`/app/objectives/${sub.id}`}
                className="flex items-center gap-3 p-3 bg-surface-2 border border-border-default rounded-lg hover:border-primary/30 transition-colors"
              >
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[sub.status] || ''}`}>
                  {sub.status}
                </span>
                <span className="flex-1 text-sm text-text-primary truncate">{sub.title}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
