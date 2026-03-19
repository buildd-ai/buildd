import { db } from '@buildd/core/db';
import { objectives, workspaces } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import StatusBadge from '@/components/StatusBadge';
import ObjectiveActions from './ObjectiveActions';
import ObjectiveConfig from './ObjectiveConfig';
import EditableTitle from './EditableTitle';
import EditableDescription from './EditableDescription';
import PrioritySelector from './PrioritySelector';
import ScheduleWizard from './ScheduleWizard';
import HeartbeatStatusBadge from './HeartbeatStatusBadge';
import HeartbeatChecklistEditor from './HeartbeatChecklistEditor';
import ActiveHoursConfig from './ActiveHoursConfig';
import HeartbeatTimeline from './HeartbeatTimeline';
import { getHeartbeatStatus, isOverdue as checkOverdue } from './heartbeat-helpers';
import PrLink from './PrLink';

export const dynamic = 'force-dynamic';

const STATUS_STYLES: Record<string, { bg: string; dot: string }> = {
  active: { bg: 'bg-status-success/10 text-status-success border border-status-success/20', dot: 'bg-status-success animate-pulse' },
  paused: { bg: 'bg-status-warning/10 text-status-warning border border-status-warning/20', dot: 'bg-status-warning' },
  completed: { bg: 'bg-primary/10 text-primary border border-primary/20', dot: 'bg-primary' },
  archived: { bg: 'bg-surface-3 text-text-muted border border-border-default', dot: 'bg-text-muted' },
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

  const [objective, teamWorkspaces] = await Promise.all([
    db.query.objectives.findFirst({
      where: eq(objectives.id, id),
      with: {
        workspace: { columns: { id: true, name: true } },
        tasks: {
          columns: { id: true, title: true, status: true, priority: true, createdAt: true, result: true, mode: true },
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
    }),
    db.query.workspaces.findMany({
      where: inArray(workspaces.teamId, teamIds),
      columns: { id: true, name: true },
    }),
  ]);

  if (!objective || !teamIds.includes(objective.teamId)) {
    notFound();
  }

  const totalTasks = objective.tasks?.length || 0;
  const completedTasks = objective.tasks?.filter(t => t.status === 'completed').length || 0;
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const activeTasks = objective.tasks?.filter(t => !['completed', 'failed'].includes(t.status)) || [];
  const doneTasks = objective.tasks?.filter(t => ['completed', 'failed'].includes(t.status)) || [];

  // Planning history — completed planning tasks
  const planningHistory = objective.tasks?.filter(t => t.mode === 'planning' && t.status === 'completed') || [];

  // Insights — structured outputs from completed execution tasks
  const insights = objective.tasks
    ?.filter(t => t.mode !== 'planning' && t.status === 'completed' && (t.result as any)?.structuredOutput)
    .map(t => ({
      taskId: t.id,
      title: t.title,
      structuredOutput: (t.result as any).structuredOutput,
      createdAt: t.createdAt,
    })) || [];

  // Configuration from schedule template
  const templateContext = (objective.schedule as any)?.taskTemplate?.context as Record<string, unknown> | undefined;
  const skillSlugs = (templateContext?.skillSlugs as string[]) || [];
  const recipeId = templateContext?.recipeId as string | undefined;
  const configModel = templateContext?.model as string | undefined;
  const outputSchema = templateContext?.outputSchema as unknown | undefined;

  // Collect all artifacts across all workers
  const allArtifacts = objective.tasks?.flatMap(t =>
    t.workers?.flatMap(w =>
      (w.artifacts || []).map(a => ({ ...a, taskTitle: t.title, workerStatus: w.status }))
    ) || []
  ) || [];

  // Heartbeat data — derived from schedule's taskTemplate.context
  const isHeartbeat = (templateContext?.heartbeat === true) || false;
  const heartbeatChecklist = (templateContext?.heartbeatChecklist as string) ?? null;
  const activeHoursStart = (templateContext?.activeHoursStart as number) ?? null;
  const activeHoursEnd = (templateContext?.activeHoursEnd as number) ?? null;
  const activeHoursTimezone = (templateContext?.activeHoursTimezone as string) ?? null;

  const heartbeatTasks = isHeartbeat
    ? (objective.tasks || []).filter(t => t.status === 'completed' || t.status === 'failed')
    : [];
  const { lastStatus: lastHeartbeatStatus, lastAt: lastHeartbeatAt } = getHeartbeatStatus(
    (objective.tasks || []).map(t => ({
      id: t.id,
      createdAt: t.createdAt,
      status: t.status,
      result: t.result,
    }))
  );
  const scheduleCron = (objective.schedule as any)?.cronExpression || null;
  const heartbeatOverdue = isHeartbeat && objective.schedule?.nextRunAt && scheduleCron
    ? checkOverdue(objective.schedule.nextRunAt, scheduleCron)
    : false;

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
      <div className="flex flex-col sm:flex-row items-start justify-between gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <EditableTitle objectiveId={objective.id} initialTitle={objective.title} />
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium shrink-0 ${STATUS_STYLES[objective.status]?.bg || ''}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${STATUS_STYLES[objective.status]?.dot || ''}`} />
              {objective.status}
            </span>
            {isHeartbeat && (
              <HeartbeatStatusBadge
                lastStatus={lastHeartbeatStatus}
                lastAt={lastHeartbeatAt}
                isOverdue={heartbeatOverdue}
              />
            )}
          </div>
          <div className="flex items-center gap-3 text-sm text-text-secondary">
            {objective.workspace && (
              <Link href={`/app/workspaces/${objective.workspace.id}`} className="text-primary hover:underline">
                {objective.workspace.name}
              </Link>
            )}
            <PrioritySelector objectiveId={objective.id} initialPriority={objective.priority} />
          </div>
        </div>
        <ObjectiveActions
          objectiveId={objective.id}
          status={objective.status}
          cronExpression={scheduleCron}
          hasWorkspace={!!objective.workspaceId}
        />
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
      <div className="mb-6">
        <EditableDescription objectiveId={objective.id} initialDescription={objective.description} />
      </div>

      {/* Heartbeat Checklist */}
      {isHeartbeat && (
        <HeartbeatChecklistEditor
          objectiveId={objective.id}
          checklist={heartbeatChecklist}
        />
      )}

      {/* Schedule Wizard — no schedule configured */}
      {!scheduleCron && (
        <div className="mb-6">
          <ScheduleWizard
            objectiveId={objective.id}
            hasWorkspace={!!objective.workspaceId}
            workspaces={teamWorkspaces}
          />
        </div>
      )}

      {/* Schedule */}
      {scheduleCron && (
        <div className="mb-6 p-3 bg-surface-2 rounded-lg border border-border-default">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-text-secondary">Schedule:</span>
            <code className="text-xs bg-surface-3 px-1.5 py-0.5 rounded">{scheduleCron}</code>
            {objective.schedule?.nextRunAt && (
              <span className="text-text-muted">
                Next: {new Date(objective.schedule.nextRunAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Active Hours (heartbeat only) */}
      {isHeartbeat && (
        <ActiveHoursConfig
          objectiveId={objective.id}
          activeHoursStart={activeHoursStart}
          activeHoursEnd={activeHoursEnd}
          activeHoursTimezone={activeHoursTimezone}
        />
      )}

      {/* Configuration */}
      <ObjectiveConfig
        objectiveId={objective.id}
        workspaceId={objective.workspaceId}
        workspace={objective.workspace}
        skillSlugs={skillSlugs}
        recipeId={recipeId || null}
        model={configModel || null}
        outputSchema={outputSchema || null}
        workspaces={teamWorkspaces}
      />

      {/* Heartbeat Timeline */}
      {isHeartbeat && heartbeatTasks.length > 0 && (
        <HeartbeatTimeline
          tasks={heartbeatTasks.map(t => ({
            id: t.id,
            createdAt: t.createdAt,
            status: t.status,
            result: t.result,
          }))}
        />
      )}

      {/* Planning History (non-heartbeat objectives) */}
      {!isHeartbeat && planningHistory.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Planning History ({planningHistory.length})
          </h2>
          <div className="space-y-2">
            {planningHistory.map(task => {
              const result = task.result as Record<string, unknown> | null;
              const summary = result?.summary as string | undefined;
              const structured = result?.structuredOutput as Record<string, unknown> | undefined;
              const tasksCreated = structured?.tasksCreated as number | undefined;
              return (
                <Link
                  key={task.id}
                  href={`/app/tasks/${task.id}`}
                  className="block p-3 bg-surface-2 border border-border-default rounded-lg hover:border-primary/30 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                      </svg>
                      <span className="text-sm text-text-primary">{timeAgo(task.createdAt)}</span>
                      {tasksCreated !== undefined && (
                        <span className="text-xs text-text-muted">({tasksCreated} task{tasksCreated !== 1 ? 's' : ''} created)</span>
                      )}
                    </div>
                    {!!structured?.objectiveComplete && (
                      <span className="text-xs bg-status-success/10 text-status-success px-2 py-0.5 rounded-full">Complete</span>
                    )}
                  </div>
                  {summary && (
                    <p className="text-xs text-text-muted mt-2 line-clamp-3">{summary}</p>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Insights — Structured Outputs */}
      {insights.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
            Insights ({insights.length})
          </h2>
          <div className="space-y-2">
            {insights.map(insight => (
              <Link
                key={insight.taskId}
                href={`/app/tasks/${insight.taskId}`}
                className="block p-3 bg-surface-2 border border-border-default rounded-lg hover:border-primary/30 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-text-primary truncate">{insight.title}</span>
                  <span className="text-xs text-text-muted shrink-0">{timeAgo(insight.createdAt)}</span>
                </div>
                <pre className="text-xs text-text-secondary bg-surface-3 p-2 rounded overflow-x-auto max-h-32">
                  {JSON.stringify(insight.structuredOutput, null, 2)}
                </pre>
              </Link>
            ))}
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
                <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted shrink-0">
                  {w.commitCount ? (
                    <span title={`${w.filesChanged || 0} files changed`}>
                      {w.commitCount} commit{w.commitCount !== 1 ? 's' : ''}
                    </span>
                  ) : null}
                  {w.prUrl && (
                    <PrLink href={w.prUrl} prNumber={w.prNumber} className="text-primary hover:underline" />
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
                        <PrLink href={latestWorker.prUrl} prNumber={latestWorker.prNumber} className="text-primary hover:underline shrink-0" />
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
                      <PrLink href={latestWorker.prUrl} prNumber={latestWorker.prNumber} className="text-xs text-primary hover:underline shrink-0" />
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
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[sub.status]?.bg || ''}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${STATUS_STYLES[sub.status]?.dot || ''}`} />
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
