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

export default async function ObjectiveDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const teamIds = await getUserTeamIds(user.id);

  const objective = await db.query.objectives.findFirst({
    where: eq(objectives.id, id),
    with: {
      workspace: { columns: { id: true, name: true } },
      tasks: {
        columns: { id: true, title: true, status: true, priority: true, createdAt: true },
        orderBy: (tasks, { desc }) => [desc(tasks.createdAt)],
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
          {objective.workspace && (
            <p className="text-sm text-text-secondary">
              Pinned to{' '}
              <Link href={`/app/workspaces/${objective.workspace.id}`} className="text-primary hover:underline">
                {objective.workspace.name}
              </Link>
            </p>
          )}
        </div>
        <ObjectiveActions objectiveId={objective.id} status={objective.status} />
      </div>

      {/* Progress */}
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

      {/* Linked Tasks — Active */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Active Tasks ({activeTasks.length})
        </h2>
        {activeTasks.length === 0 ? (
          <p className="text-sm text-text-muted">No active tasks.</p>
        ) : (
          <div className="space-y-2">
            {activeTasks.map(task => (
              <Link
                key={task.id}
                href={`/app/tasks/${task.id}`}
                className="flex items-center gap-3 p-3 bg-surface-2 border border-border-default rounded-lg hover:border-primary/30 transition-colors"
              >
                <StatusBadge status={task.status} />
                <span className="flex-1 text-sm text-text-primary truncate">{task.title}</span>
                <span className="text-xs text-text-muted">P{task.priority}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Linked Tasks — Done */}
      {doneTasks.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Completed Tasks ({doneTasks.length})
          </h2>
          <div className="space-y-2">
            {doneTasks.map(task => (
              <Link
                key={task.id}
                href={`/app/tasks/${task.id}`}
                className="flex items-center gap-3 p-3 bg-surface-2 border border-border-default rounded-lg hover:border-primary/30 transition-colors opacity-70"
              >
                <StatusBadge status={task.status} />
                <span className="flex-1 text-sm text-text-primary truncate">{task.title}</span>
              </Link>
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
