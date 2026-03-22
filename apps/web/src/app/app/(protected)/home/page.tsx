import { db } from '@buildd/core/db';
import { tasks, workers, missions as missionsTable, taskSchedules, workspaceSkills } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, gte, sql, isNotNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamIds } from '@/lib/team-access';
import { Greeting } from './greeting';
import {
  deriveMissionHealth,
  healthToGroup,
  formatNextRun,
  HEALTH_DISPLAY,
  SECTION_DISPLAY,
  GROUP_ACCENT_CLASS,
  GROUP_ORDER,
  type MissionHealth,
  type MissionGroup,
} from '@/lib/mission-helpers';

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

export default async function HomePage() {
  const user = await getCurrentUser();

  const isDev = process.env.NODE_ENV === 'development';

  let activeItems: {
    id: string;
    taskId: string;
    taskTitle: string;
    missionTitle: string | null;
    workerName: string;
    status: string;
    startedAt: Date | null;
    roleSlug: string | null;
  }[] = [];

  let recentActivity: {
    id: string;
    type: 'completed' | 'started' | 'failed';
    title: string;
    workerName: string;
    timestamp: Date;
    missionTitle: string | null;
  }[] = [];

  let missions: {
    id: string;
    title: string;
    description: string | null;
    totalTasks: number;
    completedTasks: number;
    progress: number;
    activeWorkers: number;
    health: MissionHealth;
    group: MissionGroup;
    nextScanMins: number | null;
    nextRunAt: string | null;
  }[] = [];

  let completedLast12h = 0;
  let totalTaskCount = 0;
  let lastHeartbeat: { name: string; lastHeartbeatAt: Date } | null = null;

  let pendingSuggestions: {
    scheduleId: string;
    scheduleName: string;
    workspaceId: string | null;
    reason: string;
    cronExpression?: string;
    enabled?: boolean;
    suggestedByTaskId?: string;
  }[] = [];

  let teamRoles: {
    id: string;
    name: string;
    color: string;
    slug: string;
    isActive: boolean;
    workspaceId: string;
  }[] = [];

  // Build a roles map for display
  const rolesMap = new Map<string, { name: string; color: string }>();

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
              columns: { id: true, title: true, mode: true, category: true, missionId: true, roleSlug: true },
              with: {
                mission: {
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
          missionTitle: (w.task as any)?.mission?.title || null,
          workerName: w.name,
          status: w.status,
          startedAt: w.startedAt,
          roleSlug: w.task?.roleSlug || null,
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
              columns: { id: true, title: true, missionId: true },
              with: {
                mission: {
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
          missionTitle: (w.task as any)?.mission?.title || null,
        }));

        // Missions with task progress + health
        const teamIds = await getUserTeamIds(user.id);
        if (teamIds.length > 0) {
          const allMissions = await db.query.missions.findMany({
            where: inArray(missionsTable.teamId, teamIds),
            orderBy: [desc(missionsTable.priority), desc(missionsTable.createdAt)],
            columns: { id: true, title: true, description: true, status: true },
            with: {
              tasks: {
                columns: { id: true, status: true },
              },
              schedule: { columns: { nextRunAt: true, lastRunAt: true, cronExpression: true } },
            },
            limit: 20,
          });

          // Count active workers per mission
          const missionIds = allMissions.map(m => m.id);
          let activeWorkerCounts: Record<string, number> = {};
          if (missionIds.length > 0) {
            const workerCounts = await db
              .select({
                missionId: tasks.missionId,
                activeCount: sql<number>`count(distinct ${workers.id})::int`,
              })
              .from(workers)
              .innerJoin(tasks, eq(workers.taskId, tasks.id))
              .where(
                and(
                  inArray(tasks.missionId, missionIds),
                  inArray(workers.status, ['running', 'starting', 'waiting_input'])
                )
              )
              .groupBy(tasks.missionId);

            for (const row of workerCounts) {
              if (row.missionId) {
                activeWorkerCounts[row.missionId] = row.activeCount;
              }
            }
          }

          missions = allMissions.map(mission => {
            const totalTasks = mission.tasks.length;
            const completedTasks = mission.tasks.filter(t => t.status === 'completed').length;
            const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
            const activeWorkers = activeWorkerCounts[mission.id] || 0;
            const nextRunAt = (mission.schedule as any)?.nextRunAt ?? null;
            const lastRunAt = (mission.schedule as any)?.lastRunAt ?? null;
            const cronExpression = (mission.schedule as any)?.cronExpression ?? null;
            const nextScanMins = nextRunAt
              ? Math.max(0, Math.round((new Date(nextRunAt).getTime() - Date.now()) / 60000))
              : null;

            const health = deriveMissionHealth({
              status: mission.status,
              activeAgents: activeWorkers,
              cronExpression,
              lastRunAt,
              nextRunAt,
            });

            return {
              id: mission.id,
              title: mission.title,
              description: mission.description,
              totalTasks,
              completedTasks,
              progress,
              activeWorkers,
              health,
              group: healthToGroup(health, progress),
              nextScanMins,
              nextRunAt: nextRunAt ? String(nextRunAt) : null,
            };
          });
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

        // Get team roles for mini Team section (isRole = true, dedupe by slug)
        const allRolesRaw = await db.query.workspaceSkills.findMany({
          where: and(
            inArray(workspaceSkills.workspaceId, wsIds),
            eq(workspaceSkills.enabled, true),
            eq(workspaceSkills.isRole, true),
          ),
          columns: { id: true, name: true, color: true, slug: true, workspaceId: true },
          orderBy: [desc(workspaceSkills.createdAt)],
          limit: 20,
        });
        const seenSlugs = new Set<string>();
        const allRoles = allRolesRaw.filter(r => {
          if (seenSlugs.has(r.slug)) return false;
          seenSlugs.add(r.slug);
          return true;
        }).slice(0, 8);

        // Build roles map for resolving role slugs to name/color
        allRoles.forEach(r => rolesMap.set(r.slug, { name: r.name, color: r.color }));

        // Determine which roles are active (have running workers)
        const activeSlugs = new Set(
          activeWorkers
            .map((w: any) => w.task?.roleSlug as string | null)
            .filter(Boolean)
        );

        teamRoles = allRoles.map(r => ({
          id: r.id,
          name: r.name,
          color: r.color,
          slug: r.slug,
          isActive: activeSlugs.has(r.slug),
          workspaceId: r.workspaceId,
        }));
      }
    } catch (error) {
      console.error('Home page query error:', error);
    }
  }

  const firstName = user ? getFirstName(user.name, user.email) : 'there';
  // Server runs UTC; assume EST (UTC-5) for time-aware copy
  const hour = (new Date().getUTCHours() - 5 + 24) % 24;
  const timePeriod = hour < 12 ? 'overnight' : 'today';
  const subheading = completedLast12h > 0
    ? `Your agents shipped ${completedLast12h} thing${completedLast12h === 1 ? '' : 's'} ${timePeriod}`
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
                  No agents running.
                </div>
              ) : (
                <div className="space-y-2">
                  {activeItems.map((item) => {
                    const role = item.roleSlug ? rolesMap.get(item.roleSlug) : null;
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
                              {item.missionTitle && ` \u00B7 ${item.missionTitle}`}
                            </div>
                          </div>
                          {role && (
                            <span className="flex items-center gap-1.5 shrink-0">
                              <span
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: role.color }}
                              />
                              <span className="text-[11px] text-text-muted">{role.name}</span>
                            </span>
                          )}
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
                        <span className="text-[11px] font-mono font-medium text-status-warning tracking-wide uppercase">SUGGEST</span>
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
                  <Link href="/app/missions" className="text-xs text-text-muted hover:text-text-secondary">
                    {missions.filter(m => m.group === 'running' || m.group === 'scheduled').length} active
                  </Link>
                )}
              </div>
              {missions.length === 0 ? (
                <div className="border border-dashed border-border-default rounded-[10px] p-6">
                  <p className="text-[14px] text-text-secondary">
                    No missions yet. <Link href="/app/missions/new" className="text-primary hover:underline">Create one</Link> to organize your work.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {GROUP_ORDER.map((groupKey) => {
                    const items = missions.filter(m => m.group === groupKey);
                    if (items.length === 0) return null;
                    // Sort scheduled by soonest first
                    if (groupKey === 'scheduled') {
                      items.sort((a, b) => (a.nextScanMins ?? Infinity) - (b.nextScanMins ?? Infinity));
                    }
                    const section = SECTION_DISPLAY[groupKey];
                    const isCompact = groupKey === 'completed';

                    return (
                      <div key={groupKey} className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="section-label-missions" style={{ color: section.color }}>
                            {section.label}
                          </span>
                          <span className="text-[10px] text-text-muted font-mono">{items.length}</span>
                        </div>
                        <div className="space-y-2">
                          {items.map((mission) => {
                            const healthDisplay = HEALTH_DISPLAY[mission.health];
                            const nextRun = formatNextRun(mission.nextScanMins, mission.nextRunAt);
                            const isHibernating = nextRun.urgency === 'far';

                            if (isCompact) {
                              return (
                                <Link
                                  key={mission.id}
                                  href={`/app/missions/${mission.id}`}
                                  className={`block card card-interactive mission-card mission-card-compact ${GROUP_ACCENT_CLASS[groupKey]} px-4 py-3 hover:bg-surface-3/50 transition-colors`}
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-[14px] font-medium text-text-secondary truncate">
                                      {mission.title}
                                    </span>
                                    <span className={`health-pill ${healthDisplay.colorClass}`}>
                                      {healthDisplay.label}
                                    </span>
                                  </div>
                                  {mission.totalTasks > 0 && (
                                    <div className="text-[11px] text-text-muted mt-1">
                                      {mission.completedTasks}/{mission.totalTasks} tasks
                                    </div>
                                  )}
                                </Link>
                              );
                            }

                            return (
                              <Link
                                key={mission.id}
                                href={`/app/missions/${mission.id}`}
                                className={`block card card-interactive mission-card ${GROUP_ACCENT_CLASS[groupKey]} p-4 hover:bg-surface-3/50 transition-colors ${isHibernating ? 'mission-card-hibernating' : ''}`}
                              >
                                <div className="flex items-start justify-between gap-3 mb-1.5">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-[15px] font-medium text-text-primary truncate">
                                      {mission.title}
                                    </span>
                                    <span className={`health-pill ${healthDisplay.colorClass}`}>
                                      {healthDisplay.label}
                                    </span>
                                  </div>
                                  {mission.progress > 0 && (
                                    <span className="text-[20px] font-semibold text-status-success tabular-nums flex-shrink-0">
                                      {mission.progress}%
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
                                    <div className="h-[3px] bg-[rgba(255,245,230,0.06)] rounded-full overflow-hidden">
                                      <div
                                        className="h-full rounded-full transition-all duration-500"
                                        style={{
                                          width: `${mission.progress}%`,
                                          background: 'linear-gradient(90deg, var(--status-success), #7ad4aa)',
                                        }}
                                      />
                                    </div>
                                  </div>
                                )}
                                <div className="flex items-center gap-1.5 text-[11px] text-text-muted flex-wrap">
                                  {mission.totalTasks > 0 && (
                                    <span>{mission.completedTasks}/{mission.totalTasks} tasks</span>
                                  )}
                                  {mission.activeWorkers > 0 && (
                                    <>
                                      <span className="mx-0.5">&middot;</span>
                                      <span className="text-status-success font-medium">
                                        {mission.activeWorkers} agent{mission.activeWorkers !== 1 ? 's' : ''} active
                                      </span>
                                    </>
                                  )}
                                  {nextRun.text && (
                                    <>
                                      <span className="mx-0.5">&middot;</span>
                                      <span className={nextRun.urgency === 'imminent' ? 'next-run-imminent' : isHibernating ? 'italic text-text-muted' : ''}>
                                        {nextRun.text}
                                      </span>
                                    </>
                                  )}
                                </div>
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex items-center justify-between pt-1">
                    <Link
                      href="/app/missions"
                      className="text-xs text-text-muted hover:text-text-secondary"
                    >
                      View all missions
                    </Link>
                    <Link
                      href="/app/missions/new"
                      className="text-xs text-text-muted hover:text-primary"
                    >
                      + New Mission
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right column: Team + Activity rail */}
          <div className="md:w-[40%] md:border-l md:border-border-default md:pl-8">
            {/* Team section — above Activity for visibility */}
            {teamRoles.length > 0 && (
              <div className="mb-6 pb-6 border-b border-border-default">
                <div className="flex items-center justify-between mb-4">
                  <div className="section-label">Team</div>
                  <Link href="/app/team" className="text-xs text-text-muted hover:text-text-secondary">
                    {teamRoles.filter(r => r.isActive).length} active &middot; {teamRoles.length} total
                  </Link>
                </div>
                <div className="flex flex-wrap gap-2">
                  {teamRoles.map((role) => (
                    <Link
                      key={role.id}
                      href={`/app/workspaces/${role.workspaceId}/skills/${role.id}`}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--card)] border border-border-default hover:bg-surface-3 transition-colors"
                    >
                      <div
                        className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${role.isActive ? 'ring-2 ring-status-success/50' : ''}`}
                        style={{ backgroundColor: role.color }}
                      >
                        <span className="text-white text-[9px] font-bold">{role.name[0]?.toUpperCase()}</span>
                      </div>
                      <span className="text-[12px] font-medium text-text-primary">{role.name}</span>
                      {role.isActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" />
                      )}
                    </Link>
                  ))}
                </div>
              </div>
            )}

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
                          {event.missionTitle && ` \u00B7 ${event.missionTitle}`}
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
