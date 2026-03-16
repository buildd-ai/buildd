import { db } from '@buildd/core/db';
import { tasks, workers, objectives, taskSchedules } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, gte, sql, isNotNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamIds } from '@/lib/team-access';
import { Greeting } from './greeting';

// --- Helpers ---

function getFirstName(name: string | null, email: string): string {
  if (name) {
    return name.split(' ')[0];
  }
  return email.split('@')[0];
}

function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTime(date: Date | string): string {
  return new Date(date).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function getTaskTypeLabel(task: { mode?: string; category?: string | null }): { label: string; className: string } {
  if (task.mode === 'planning') {
    return { label: 'BRIEF', className: 'type-label type-label-brief' };
  }
  if (task.category === 'chore' || task.category === 'infra') {
    return { label: 'WATCH', className: 'type-label type-label-watch' };
  }
  return { label: 'BUILD', className: 'type-label type-label-build' };
}

export default async function HomePage() {
  const user = await getCurrentUser();

  const isDev = process.env.NODE_ENV === 'development';

  let activeItems: {
    id: string;
    taskId: string;
    taskTitle: string;
    objectiveTitle: string | null;
    workerName: string;
    status: string;
    startedAt: Date | null;
    mode: string;
    category: string | null;
  }[] = [];

  let recentActivity: {
    id: string;
    type: 'completed' | 'started' | 'failed';
    title: string;
    workerName: string;
    timestamp: Date;
    objectiveTitle: string | null;
  }[] = [];

  let missions: {
    id: string;
    title: string;
    description: string | null;
    isHeartbeat: boolean;
    totalTasks: number;
    completedTasks: number;
    activeWorkers: number;
  }[] = [];

  let completedLast12h = 0;
  let totalTaskCount = 0;
  let lastHeartbeat: { name: string; lastHeartbeatAt: Date } | null = null;

  let pendingSuggestions: {
    scheduleId: string;
    scheduleName: string;
    workspaceId: string;
    reason: string;
    cronExpression?: string;
    enabled?: boolean;
    suggestedByTaskId?: string;
  }[] = [];

  let pendingSuggestions: {
    scheduleId: string;
    scheduleName: string;
    workspaceId: string;
    reason: string;
    cronExpression?: string;
    enabled?: boolean;
    suggestedByTaskId?: string;
  }[] = [];

  if (!isDev) {
    if (!user) {
      redirect('/app/auth/signin');
    }

    try {
      const wsIds = await getUserWorkspaceIds(user.id);

      if (wsIds.length > 0) {
        // Count total tasks to distinguish new vs returning users
        const totalResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(tasks)
          .where(inArray(tasks.workspaceId, wsIds));
        totalTaskCount = totalResult[0]?.count || 0;

        // Count tasks completed in last 12 hours for the subheading
        const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
        const countResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(workers)
          .where(
            and(
              inArray(workers.workspaceId, wsIds),
              eq(workers.status, 'completed'),
              gte(workers.completedAt, twelveHoursAgo)
            )
          );
        completedLast12h = countResult[0]?.count || 0;

        // Active workers with their tasks and objectives
        const activeWorkers = await db.query.workers.findMany({
          where: and(
            inArray(workers.workspaceId, wsIds),
            inArray(workers.status, ['running', 'starting', 'waiting_input'])
          ),
          orderBy: desc(workers.createdAt),
          limit: 10,
          with: {
            task: {
              columns: { id: true, title: true, mode: true, category: true, objectiveId: true },
              with: {
                objective: {
                  columns: { title: true },
                },
              },
            },
          },
        });

        activeItems = activeWorkers.map((w: any) => ({
          id: w.id,
          taskId: w.task?.id || '',
          taskTitle: w.task?.title || w.name,
          objectiveTitle: (w.task as any)?.objective?.title || null,
          workerName: w.name,
          status: w.status,
          startedAt: w.startedAt,
          mode: w.task?.mode || 'execution',
          category: w.task?.category || null,
        }));

        // Recent completed/failed workers for activity feed
        const recentWorkers = await db.query.workers.findMany({
          where: and(
            inArray(workers.workspaceId, wsIds),
            inArray(workers.status, ['completed', 'failed'])
          ),
          orderBy: desc(workers.completedAt),
          limit: 6,
          with: {
            task: {
              columns: { id: true, title: true, objectiveId: true },
              with: {
                objective: {
                  columns: { title: true },
                },
              },
            },
          },
        });

        recentActivity = recentWorkers.map((w: any) => ({
          id: w.id,
          type: w.status === 'completed' ? 'completed' as const : 'failed' as const,
          title: w.task?.title || w.name,
          workerName: w.name,
          timestamp: w.completedAt || w.updatedAt,
          objectiveTitle: (w.task as any)?.objective?.title || null,
        }));

        // Active objectives (missions) with task progress
        const teamIds = await getUserTeamIds(user.id);
        if (teamIds.length > 0) {
          const activeObjectives = await db.query.objectives.findMany({
            where: and(
              inArray(objectives.teamId, teamIds),
              eq(objectives.status, 'active')
            ),
            orderBy: [desc(objectives.priority), desc(objectives.createdAt)],
            columns: { id: true, title: true, description: true, isHeartbeat: true },
            with: {
              tasks: {
                columns: { id: true, status: true },
              },
            },
            limit: 10,
          });

          // Count active workers per objective
          const objectiveIds = activeObjectives.map(o => o.id);
          let activeWorkerCounts: Record<string, number> = {};
          if (objectiveIds.length > 0) {
            const workerCounts = await db
              .select({
                objectiveId: tasks.objectiveId,
                activeCount: sql<number>`count(distinct ${workers.id})::int`,
              })
              .from(workers)
              .innerJoin(tasks, eq(workers.taskId, tasks.id))
              .where(
                and(
                  inArray(tasks.objectiveId, objectiveIds),
                  inArray(workers.status, ['running', 'starting', 'waiting_input'])
                )
              )
              .groupBy(tasks.objectiveId);

            for (const row of workerCounts) {
              if (row.objectiveId) {
                activeWorkerCounts[row.objectiveId] = row.activeCount;
              }
            }
          }

          missions = activeObjectives.map(obj => ({
            id: obj.id,
            title: obj.title,
            description: obj.description,
            isHeartbeat: obj.isHeartbeat,
            totalTasks: obj.tasks.length,
            completedTasks: obj.tasks.filter(t => t.status === 'completed').length,
            activeWorkers: activeWorkerCounts[obj.id] || 0,
          }));
        }

        // Schedules with pending agent suggestions
        const schedulesWithSuggestions = await db.query.taskSchedules.findMany({
          where: and(
            inArray(taskSchedules.workspaceId, wsIds),
            isNotNull(taskSchedules.pendingSuggestion),
          ),
          columns: {
            id: true,
            name: true,
            workspaceId: true,
            pendingSuggestion: true,
          },
          limit: 5,
        });

        pendingSuggestions = schedulesWithSuggestions
          .filter(s => s.pendingSuggestion)
          .map(s => {
            const ps = s.pendingSuggestion as any;
            return {
              scheduleId: s.id,
              scheduleName: s.name,
              workspaceId: s.workspaceId,
              reason: ps.reason,
              cronExpression: ps.cronExpression,
              enabled: ps.enabled,
              suggestedByTaskId: ps.suggestedByTaskId,
            };
          });
      }
    } catch (error) {
      console.error('Home page query error:', error);
    }
  }

  const firstName = user ? getFirstName(user.name, user.email) : 'there';
  const subheading = completedLast12h > 0
    ? `Your agents shipped ${completedLast12h} thing${completedLast12h === 1 ? '' : 's'} overnight`
    : 'Your agents are standing by';

  return (
    <main className="min-h-screen pt-4 px-4 pb-20 md:pt-8 md:px-8 md:pb-8">
      <div className="max-w-5xl mx-auto">
        {/* Desktop two-column layout */}
        <div className="md:flex md:gap-0">
          {/* Left column: Greeting + Right Now */}
          <div className="md:w-[60%] md:pr-8">
            {/* Greeting */}
            <div className="mb-8 md:mb-10">
              <Greeting firstName={firstName} />
              <p className="text-[15px] text-text-secondary font-light mt-1.5">
                {subheading}
              </p>
            </div>

            {/* Right Now */}
            <div className="mb-8">
              <div className="section-label mb-4">Right Now</div>
              {activeItems.length === 0 && totalTaskCount === 0 ? (
                <div className="border border-dashed border-border-default rounded-[10px] p-5">
                  <div className="text-[13px] font-medium text-text-primary mb-3">Get started</div>
                  <div className="space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="w-5 h-5 rounded-full border border-border-default flex items-center justify-center flex-shrink-0 mt-0.5">
                        <span className="text-[10px] font-mono text-text-muted">1</span>
                      </div>
                      <div className="min-w-0">
                        <div className="text-[13px] text-text-primary">Install the CLI</div>
                        <div className="mt-1.5 px-3 py-2 bg-surface-3 rounded-[6px] font-mono text-[11px] text-text-secondary overflow-x-auto">
                          curl -fsSL https://buildd.dev/install.sh | bash
                        </div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <div className="w-5 h-5 rounded-full border border-border-default flex items-center justify-center flex-shrink-0 mt-0.5">
                        <span className="text-[10px] font-mono text-text-muted">2</span>
                      </div>
                      <div className="min-w-0">
                        <div className="text-[13px] text-text-primary">Log in &amp; connect</div>
                        <div className="mt-1.5 px-3 py-2 bg-surface-3 rounded-[6px] font-mono text-[11px] text-text-secondary overflow-x-auto">
                          buildd login
                        </div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <div className="w-5 h-5 rounded-full border border-border-default flex items-center justify-center flex-shrink-0 mt-0.5">
                        <span className="text-[10px] font-mono text-text-muted">3</span>
                      </div>
                      <div className="min-w-0">
                        <div className="text-[13px] text-text-primary">
                          <Link href="/app/tasks/new" className="text-primary hover:underline">Create a task</Link>
                          {' '}or start the runner
                        </div>
                        <div className="mt-1.5 px-3 py-2 bg-surface-3 rounded-[6px] font-mono text-[11px] text-text-secondary overflow-x-auto">
                          buildd
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : activeItems.length === 0 ? (
                <div className="text-[14px] text-text-secondary">
                  No agents running. <Link href="/app/tasks/new" className="text-primary hover:underline">Create a task</Link> to get one going.
                </div>
              ) : (
                <div className="space-y-2">
                  {activeItems.map((item) => {
                    const typeLabel = getTaskTypeLabel({ mode: item.mode, category: item.category });
                    return (
                      <Link
                        key={item.id}
                        href={`/app/tasks/${item.taskId}`}
                        className="block border-l-2 border-accent bg-card-rightnow rounded-r-[10px] px-4 py-3 hover:bg-surface-3 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-[15px] font-medium text-text-primary truncate">
                              {item.taskTitle}
                            </div>
                            <div className="text-[12px] font-light text-text-secondary mt-0.5 truncate">
                              {item.workerName}
                              {item.startedAt && ` \u00B7 ${timeAgo(item.startedAt)}`}
                              {item.objectiveTitle && ` \u00B7 ${item.objectiveTitle}`}
                            </div>
                          </div>
                          <span className={typeLabel.className}>
                            {typeLabel.label}
                          </span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Pending Schedule Suggestions */}
            {pendingSuggestions.length > 0 && (
              <div className="mb-8">
                <div className="section-label mb-4">Needs Attention</div>
                <div className="space-y-2">
                  {pendingSuggestions.map((s) => (
                    <Link
                      key={s.scheduleId}
                      href={`/app/workspaces/${s.workspaceId}/schedules`}
                      className="block border-l-2 border-status-warning bg-status-warning/5 rounded-r-[10px] px-4 py-3 hover:bg-status-warning/10 transition-colors"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="type-label type-label-watch">SUGGEST</span>
                        <span className="text-[13px] font-medium text-text-primary truncate">
                          {s.scheduleName}
                        </span>
                      </div>
                      <p className="text-[12px] text-text-secondary line-clamp-2">{s.reason}</p>
                      <p className="text-[11px] text-text-muted font-mono mt-1">
                        {[
                          s.cronExpression && `cron → ${s.cronExpression}`,
                          s.enabled === false && 'disable',
                          s.enabled === true && 'enable',
                        ].filter(Boolean).join(', ')}
                      </p>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Missions */}
            <div className="mb-8 md:mb-0">
              <div className="flex items-center justify-between mb-4">
                <div className="section-label">Missions</div>
                {missions.length > 0 && (
                  <Link href="/app/objectives" className="text-xs text-text-muted hover:text-text-secondary">
                    {missions.length} active
                  </Link>
                )}
              </div>
              {missions.length === 0 ? (
                <div className="border border-dashed border-border-default rounded-[10px] p-6">
                  <p className="text-[14px] text-text-secondary">
                    No active missions. <Link href="/app/objectives" className="text-primary hover:underline">Create one</Link> to organize your work.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {missions.map((mission) => {
                    const pct = mission.totalTasks > 0
                      ? Math.round((mission.completedTasks / mission.totalTasks) * 100)
                      : 0;
                    const typeLabel = mission.isHeartbeat
                      ? { label: 'WATCH', className: 'type-label type-label-watch' }
                      : { label: 'BUILD', className: 'type-label type-label-build' };

                    return (
                      <Link
                        key={mission.id}
                        href={`/app/objectives/${mission.id}`}
                        className="block card card-interactive p-4 hover:bg-surface-3/50 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={typeLabel.className}>{typeLabel.label}</span>
                            <span className="text-[15px] font-medium text-text-primary truncate">
                              {mission.title}
                            </span>
                          </div>
                          {pct > 0 && (
                            <span className="text-[20px] font-semibold text-primary tabular-nums flex-shrink-0">
                              {pct}%
                            </span>
                          )}
                        </div>
                        {mission.description && (
                          <p className="text-[12px] text-text-secondary mb-2 line-clamp-1">
                            {mission.description}
                          </p>
                        )}
                        {mission.totalTasks > 0 && (
                          <div className="mb-2">
                            <div className="h-1 bg-surface-3 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-primary rounded-full transition-all"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        )}
                        <div className="flex items-center gap-3 text-[11px] text-text-muted">
                          {mission.totalTasks > 0 && (
                            <span>{mission.completedTasks}/{mission.totalTasks} tasks</span>
                          )}
                          {mission.activeWorkers > 0 && (
                            <span className="text-primary font-medium">
                              {mission.activeWorkers} agent{mission.activeWorkers !== 1 ? 's' : ''} active
                            </span>
                          )}
                        </div>
                      </Link>
                    );
                  })}
                  <Link
                    href="/app/objectives"
                    className="block text-center text-xs text-text-muted hover:text-text-secondary py-2"
                  >
                    View all objectives
                  </Link>
                </div>
              )}
            </div>
          </div>

          {/* Right column: Activity rail */}
          <div className="md:w-[40%] md:border-l md:border-border-default md:pl-8">
            <div className="section-label mb-4">Activity</div>
            {recentActivity.length === 0 ? (
              <p className="text-[14px] text-text-secondary">
                No recent activity yet.
              </p>
            ) : (
              <div className="space-y-4">
                {recentActivity.map((event) => {
                  const dotColor = event.type === 'completed'
                    ? 'bg-status-success'
                    : 'bg-status-error';

                  return (
                    <div key={event.id} className="flex items-start gap-3">
                      <div className="flex flex-col items-center pt-1.5">
                        <div className={`w-[7px] h-[7px] rounded-full ${dotColor} flex-shrink-0`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px] text-text-primary truncate">
                          {event.title}
                        </div>
                        <div className="text-[10px] text-text-muted mt-0.5">
                          via {event.workerName}
                          {event.objectiveTitle && ` \u00B7 ${event.objectiveTitle}`}
                        </div>
                      </div>
                      <span className="font-mono text-[11px] text-text-muted whitespace-nowrap flex-shrink-0 pt-0.5">
                        {formatTime(event.timestamp)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
