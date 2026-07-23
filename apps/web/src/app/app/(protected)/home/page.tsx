import { db } from '@buildd/core/db';
import { tasks, workers, missions as missionsTable, taskSchedules, workspaceSkills, workspaces as workspacesTable, missionNotes } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, gte, sql, isNotNull, or, isNull, ne, like } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamIds, getTeamWorkspaceIds } from '@/lib/team-access';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';
import { Greeting } from './greeting';
import { resolvePolicy } from '@/lib/merge-policy';
import MergeConfirmButton from '@/components/MergeConfirmButton';
import ExternalLink from '@/components/ExternalLink';
import TaskCard from '@/components/TaskCard';
import StatusBadge from '@/components/StatusBadge';
import { deriveChainPosition, deriveIntensity } from '@/lib/task-presentation';
import type { ChainPositionResult } from '@/lib/task-presentation';

export const dynamic = 'force-dynamic';
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
import { LIVE_WORKER_STATUSES } from '@/lib/task-timestamps';

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

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ workspace?: string }>;
}) {
  const { workspace: wsFilter } = (await searchParams) ?? {};
  const user = await getCurrentUser();

  const isDev = process.env.NODE_ENV === 'development';

  let activeItems: {
    id: string;
    taskId: string;
    taskTitle: string;
    taskCreatedAt: string;
    taskUpdatedAt: string;
    taskStatus: string;
    missionId: string | null;
    missionTitle: string | null;
    workspaceName: string | null;
    workerName: string;
    workerStatus: string;
    startedAt: Date | null;
    workerUpdatedAt: string | null;
    prUrl: string | null;
    prNumber: number | null;
    roleSlug: string | null;
    attemptCurrent: number | null;
    attemptTotal: number | null;
    chain: ChainPositionResult | null;
    intensityTier: 'fresh' | 'working' | 'slow' | 'stalled';
  }[] = [];

  let recentActivity: {
    id: string;
    taskId: string | null;
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
    workspaceName: string | null;
    orchestrationMode: string | null;
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
    workspaceId: string | null;
  }[] = [];

  let teamWorkspaces: { id: string; name: string }[] = [];

  let escalationInbox: {
    workerId: string;
    taskId: string;
    taskTitle: string;
    workspaceId: string;
    workspaceName: string;
    prNumber: number | null;
    prUrl: string | null;
    policyTier: string;
    escalationReason: string | null;
    waitingMinutes: number | null;
  }[] = [];

  // Build a roles map for display
  const rolesMap = new Map<string, { name: string; color: string }>();

  if (!isDev) {
    if (!user) {
      redirect('/app/auth/signin');
    }

    try {
      const cookieStore = await cookies();
      const cookieTeamId = cookieStore.get('buildd-team')?.value;

      // Only scope to a specific team when the cookie is explicitly set and the
      // user is a member of that team. Without a valid cookie, show cross-team
      // data for all the user's workspaces (same as pre-#1009 behaviour) so
      // the Home screen is never empty or stale on first load / after clearing cookies.
      let activeTeamId: string | null = null;
      if (cookieTeamId) {
        const userTeamIds = await getUserTeamIds(user.id);
        if (userTeamIds.includes(cookieTeamId)) {
          activeTeamId = cookieTeamId;
        }
      }

      // Workspace IDs for worker/task queries
      let wsIds: string[];
      if (activeTeamId) {
        const teamWsIds = await getTeamWorkspaceIds(activeTeamId);

        // Load team workspaces for filter dropdown
        if (teamWsIds.length > 0) {
          teamWorkspaces = await db
            .select({ id: workspacesTable.id, name: workspacesTable.name })
            .from(workspacesTable)
            .where(inArray(workspacesTable.id, teamWsIds));
        }

        // Narrow to selected workspace if filter is set (must belong to team)
        wsIds = (wsFilter && teamWsIds.includes(wsFilter)) ? [wsFilter] : teamWsIds;
      } else {
        // No valid team cookie → show all user workspaces cross-team
        wsIds = await getUserWorkspaceIds(user.id);
      }

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
            inArray(workers.status, [...LIVE_WORKER_STATUSES])
          ),
          orderBy: desc(workers.createdAt),
          limit: 10,
          with: {
            task: {
              columns: {
                id: true, title: true, mode: true, category: true,
                missionId: true, roleSlug: true, status: true,
                createdAt: true, updatedAt: true, dependsOn: true, context: true,
              },
              with: {
                mission: { columns: { title: true } },
                workspace: { columns: { name: true } },
              },
            },
          },
        });

        // Collect dep IDs for chain computation
        const allDepIds = [...new Set(
          activeWorkers.flatMap((w: any) => (w.task?.dependsOn as string[] | null) ?? [])
        )];
        const depTaskInfoMap = new Map<string, {
          id: string; status: string;
          workers: Array<{ prUrl: string | null; prNumber: number | null; mergedAt: string | null }>;
        }>();
        if (allDepIds.length > 0) {
          const depTasks = await db.query.tasks.findMany({
            where: inArray(tasks.id, allDepIds),
            columns: { id: true, status: true },
            with: {
              workers: {
                columns: { prUrl: true, prNumber: true, mergedAt: true },
                orderBy: (w: any, { desc: d }: any) => [d(w.startedAt)],
                limit: 1,
              },
            },
          });
          for (const dt of depTasks) {
            depTaskInfoMap.set(dt.id, {
              id: dt.id,
              status: dt.status,
              workers: dt.workers.map((w: any) => ({
                prUrl: w.prUrl ?? null,
                prNumber: w.prNumber ?? null,
                mergedAt: w.mergedAt ? String(w.mergedAt) : null,
              })),
            });
          }
        }

        // Count dependents within this active set + recently loaded workspace tasks
        const activeTaskIds = new Set(activeWorkers.map((w: any) => w.task?.id).filter(Boolean));
        const dependentCountMap = new Map<string, number>();
        for (const w of activeWorkers) {
          for (const depId of (w.task?.dependsOn as string[] | null) ?? []) {
            dependentCountMap.set(depId, (dependentCountMap.get(depId) ?? 0) + 1);
          }
        }

        activeItems = activeWorkers.map((w: any) => {
          const task = w.task;
          const ctx = (task?.context || {}) as Record<string, unknown>;
          const depIds = (task?.dependsOn as string[] | null) ?? [];
          const deps = depIds.map((id: string) => depTaskInfoMap.get(id)).filter(Boolean) as Array<{
            id: string; title: string; status: string;
            workers: Array<{ prUrl: string | null; prNumber: number | null; mergedAt: string | null }>;
          }>;
          const resolvedDeps = depIds.map((id: string) => {
            const dt = depTaskInfoMap.get(id);
            return dt ? { ...dt, title: id } : null;
          }).filter(Boolean) as Array<{ id: string; title: string; status: string; workers: Array<{ prUrl: string | null; prNumber: number | null; mergedAt: string | null }> }>;
          const dependents = dependentCountMap.get(task?.id) ?? 0;
          const chain = (resolvedDeps.length > 0 || dependents > 0)
            ? deriveChainPosition({ task: { id: task?.id ?? '', status: task?.status ?? 'pending' }, deps: resolvedDeps, dependents })
            : null;
          const intensity = deriveIntensity({
            turns: [],
            startedAt: w.startedAt ? w.startedAt.toISOString() : null,
            workerUpdatedAt: w.updatedAt ? w.updatedAt.toISOString() : null,
          });
          return {
            id: w.id,
            taskId: task?.id || '',
            taskTitle: task?.title || w.name,
            taskCreatedAt: task?.createdAt ? task.createdAt.toISOString() : new Date().toISOString(),
            taskUpdatedAt: task?.updatedAt ? task.updatedAt.toISOString() : new Date().toISOString(),
            taskStatus: task?.status ?? 'assigned',
            missionId: task?.missionId ?? null,
            missionTitle: task?.mission?.title ?? null,
            workspaceName: task?.workspace?.name ?? null,
            workerName: w.name,
            workerStatus: w.status,
            startedAt: w.startedAt,
            workerUpdatedAt: w.updatedAt ? w.updatedAt.toISOString() : null,
            prUrl: w.prUrl ?? null,
            prNumber: w.prNumber ?? null,
            roleSlug: task?.roleSlug ?? null,
            attemptCurrent: typeof ctx.iteration === 'number' ? ctx.iteration + 1 : null,
            attemptTotal: typeof ctx.maxIterations === 'number' ? ctx.maxIterations : null,
            chain,
            intensityTier: intensity.tier,
          };
        });

        // Recent completed/failed/error workers for activity feed.
        // Order by COALESCE(completedAt, updatedAt) so error workers (null
        // completedAt) sort by their updatedAt rather than floating to the top
        // via PostgreSQL's default NULLS FIRST for DESC ordering.
        // Window to 30 days: "Activity" is a recency feed — months-old workers
        // from dormant workspaces are noise, an empty state is honest.
        const activityWindowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const recentWorkers = await db.query.workers.findMany({
          where: and(
            inArray(workers.workspaceId, wsIds),
            inArray(workers.status, ['completed', 'failed', 'error']),
            sql`COALESCE(${workers.completedAt}, ${workers.updatedAt}) >= ${activityWindowStart}`
          ),
          orderBy: sql`COALESCE(${workers.completedAt}, ${workers.updatedAt}) DESC`,
          limit: 12,
          with: {
            task: {
              columns: { id: true, title: true, missionId: true, roleSlug: true },
              with: {
                mission: {
                  columns: { title: true },
                },
              },
            },
            workspace: { columns: { name: true } },
          },
        });

        // One row per task (a retried task can have several terminal workers —
        // keep only the newest) and cap at 6 for the feed.
        const seenTasks = new Set<string>();
        recentActivity = recentWorkers
          .filter((w: any) => {
            const key = w.task?.id || w.id;
            if (seenTasks.has(key)) return false;
            seenTasks.add(key);
            return true;
          })
          .slice(0, 6)
          .map((w: any) => ({
            id: w.id,
            taskId: w.task?.id || null,
            type: w.status === 'completed' ? 'completed' as const : 'failed' as const,
            title: w.task?.title || w.name,
            // "via <workspace> · <role>" beats the runner's machine name —
            // runner names (e.g. coder-workspace-x) carry no meaning here.
            workerName: [w.workspace?.name, w.task?.roleSlug].filter(Boolean).join(' · ') || w.name,
            timestamp: w.completedAt || w.updatedAt,
            missionTitle: (w.task as any)?.mission?.title || null,
          }));

        // Missions with task progress + health
        // Scope: active team (cookie set) or all user teams (no cookie).
        {
          const missionTeamIds = activeTeamId
            ? [activeTeamId]
            : await getUserTeamIds(user.id);

          const missionsWhere = missionTeamIds.length > 0
            ? (wsFilter && activeTeamId
                ? and(
                    eq(missionsTable.teamId, activeTeamId),
                    or(eq(missionsTable.workspaceId, wsFilter), isNull(missionsTable.workspaceId)),
                  )
                : inArray(missionsTable.teamId, missionTeamIds))
            : undefined;

          // Exclude archived missions: they can never be active/scheduled on Home,
          // and they fill limit slots that should go to genuinely active missions.
          const allMissions = missionsWhere ? await db.query.missions.findMany({
            where: and(missionsWhere, ne(missionsTable.status, 'archived')),
            orderBy: [desc(missionsTable.priority), desc(missionsTable.createdAt)],
            columns: { id: true, title: true, description: true, status: true, orchestrationMode: true },
            with: {
              tasks: {
                columns: { id: true, status: true },
              },
              schedule: { columns: { nextRunAt: true, lastRunAt: true, cronExpression: true } },
              workspace: { columns: { id: true, name: true } },
            },
            limit: 50,
          }) : [];

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
                  inArray(workers.status, [...LIVE_WORKER_STATUSES])
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

            const orchestrationMode = (mission as any).orchestrationMode ?? null;
            const health = deriveMissionHealth({
              status: mission.status,
              activeAgents: activeWorkers,
              cronExpression,
              lastRunAt,
              nextRunAt,
              orchestrationMode,
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
              workspaceName: (mission.workspace as any)?.name || null,
              orchestrationMode,
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

        // Escalation inbox (BT-15): PRs needing human action
        {
          const openPrWorkers = await db.query.workers.findMany({
            where: and(
              inArray(workers.workspaceId, wsIds),
              isNotNull(workers.prUrl),
              isNull(workers.mergedAt),
            ),
            columns: { id: true, taskId: true, workspaceId: true, prUrl: true, prNumber: true, completedAt: true },
            with: { task: { columns: { id: true, title: true, missionId: true } } },
          });

          if (openPrWorkers.length > 0) {
            const openTaskIds = openPrWorkers.map(w => w.taskId).filter(Boolean) as string[];
            const escalatedNotes = openTaskIds.length > 0
              ? await db.query.missionNotes.findMany({
                  where: and(
                    inArray(missionNotes.taskId, openTaskIds),
                    eq(missionNotes.type, 'reviewer_escalated'),
                  ),
                  columns: { taskId: true, body: true, title: true },
                })
              : [];
            const escalatedMap = new Map<string, string>();
            for (const n of escalatedNotes) {
              if (n.taskId && !escalatedMap.has(n.taskId)) {
                escalatedMap.set(n.taskId, n.body ?? n.title);
              }
            }

            const wsRowsForInbox = await db.query.workspaces.findMany({
              where: inArray(workspacesTable.id, [...new Set(openPrWorkers.map(w => w.workspaceId))]),
              columns: { id: true, name: true, gitConfig: true },
            });
            const wsInboxMap = new Map(wsRowsForInbox.map(ws => [ws.id, ws]));

            escalationInbox = openPrWorkers
              .filter(w => {
                if (w.taskId && escalatedMap.has(w.taskId)) return true;
                const ws = wsInboxMap.get(w.workspaceId);
                if (!ws) return false;
                return resolvePolicy(ws).tier === 'human';
              })
              .map(w => {
                const ws = wsInboxMap.get(w.workspaceId);
                const policy = ws ? resolvePolicy(ws) : { tier: 'auto-threshold' as const };
                const reason = (w.taskId ? escalatedMap.get(w.taskId) : undefined)
                  ?? (policy.tier === 'human' ? 'Human Gate — manual merge required' : null);
                const waitingMinutes = w.completedAt
                  ? Math.round((Date.now() - new Date(w.completedAt).getTime()) / 60000)
                  : null;
                return {
                  workerId: w.id,
                  taskId: w.taskId ?? '',
                  taskTitle: (w.task as any)?.title ?? '',
                  workspaceId: w.workspaceId,
                  workspaceName: ws?.name ?? '',
                  prNumber: w.prNumber,
                  prUrl: w.prUrl,
                  policyTier: policy.tier,
                  escalationReason: reason,
                  waitingMinutes,
                };
              })
              .slice(0, 10);
          }
        }

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
    <main className="min-h-screen pt-14 px-4 pb-20 md:pt-8 md:px-8 md:pb-8">
      <div className="max-w-5xl mx-auto">
        {/* Workspace filter — narrows all sections to a single workspace */}
        {teamWorkspaces.length > 0 && (
          <div className="flex justify-end mb-4">
            <WorkspaceFilter workspaces={teamWorkspaces} selectedId={wsFilter ?? null} />
          </div>
        )}
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
              {activeItems.length === 0 && teamWorkspaces.length === 0 ? (
                <div className="border border-dashed border-border-default rounded-[10px] p-5">
                  <div className="text-[13px] font-medium text-text-primary mb-2">Create a workspace</div>
                  <p className="text-[13px] text-text-secondary mb-4">
                    This team doesn&rsquo;t have a workspace yet. Connect a GitHub repo to start running agents here.
                  </p>
                  <Link
                    href="/app/workspaces/new"
                    className="inline-flex items-center gap-1.5 rounded-[6px] bg-primary px-3 py-2 text-[13px] font-medium text-white hover:opacity-90 transition-opacity"
                  >
                    Connect a repo
                  </Link>
                </div>
              ) : activeItems.length === 0 && totalTaskCount === 0 ? (
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
                <div>
                  <div className="text-[14px] text-text-secondary mb-3">No agents running.</div>
                  {teamRoles.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {teamRoles.map((role) => (
                        <Link
                          key={role.id}
                          href="/app/team"
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-2 border border-border-default"
                        >
                          <div
                            className="w-4 h-4 flex items-center justify-center flex-shrink-0 border border-border-strong"
                          >
                            <span className="text-text-primary text-[8px] font-bold">{role.name[0]?.toUpperCase()}</span>
                          </div>
                          <span className="text-[11px] text-text-muted">{role.name}</span>
                          <span className="text-[10px] text-text-muted/60">idle</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {activeItems.map((item) => (
                    <TaskCard
                      key={item.id}
                      id={item.taskId}
                      title={item.taskTitle}
                      taskStatus={item.taskStatus}
                      workerStatus={item.workerStatus}
                      missionId={item.missionId}
                      missionTitle={item.missionTitle}
                      workspaceName={item.workspaceName}
                      chain={item.chain}
                      taskCreatedAt={item.taskCreatedAt}
                      taskUpdatedAt={item.taskUpdatedAt}
                      workerStartedAt={item.startedAt ? item.startedAt.toISOString() : null}
                      workerUpdatedAt={item.workerUpdatedAt}
                      intensity={{ tier: item.intensityTier, sparkline: [] }}
                      attemptCurrent={item.attemptCurrent}
                      attemptTotal={item.attemptTotal}
                      runnerName={item.workerName}
                      prUrl={item.prUrl}
                      prNumber={item.prNumber}
                      density="full"
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Escalation Inbox (BT-15) — PRs requiring human action */}
            {escalationInbox.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center justify-between mb-4">
                  <div className="section-label">Needs Your Review</div>
                  <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[11px] font-bold rounded-full bg-status-error text-white">
                    {escalationInbox.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {escalationInbox.map((item) => {
                    const tierLabel =
                      item.policyTier === 'human' ? 'Human Gate'
                      : item.policyTier === 'agent-review' ? 'Agent Review'
                      : 'Auto';
                    return (
                      <div
                        key={item.workerId}
                        className="border-l-2 border-status-error bg-status-error/5 rounded-r-[10px] px-4 py-3"
                      >
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap mb-0.5">
                              <span className="text-[10px] font-mono font-medium text-status-error tracking-wide uppercase">
                                {tierLabel}
                              </span>
                              {item.waitingMinutes != null && item.waitingMinutes > 0 && (
                                <span className="text-[10px] text-text-muted">
                                  Waiting {item.waitingMinutes < 60
                                    ? `${item.waitingMinutes}m`
                                    : `${Math.floor(item.waitingMinutes / 60)}h`}
                                </span>
                              )}
                            </div>
                            <Link
                              href={`/app/tasks/${item.taskId}`}
                              className="text-[13px] font-medium text-text-primary truncate hover:underline block"
                            >
                              {item.taskTitle}
                            </Link>
                            {item.workspaceName && (
                              <div className="text-[11px] text-text-muted mt-0.5">{item.workspaceName}</div>
                            )}
                          </div>
                        </div>
                        {item.escalationReason && (
                          <p className="text-[12px] text-text-secondary line-clamp-2 mb-2">
                            {item.escalationReason}
                          </p>
                        )}
                        <div className="flex items-center gap-2 flex-wrap mt-2">
                          {item.prUrl && (
                            <ExternalLink
                              href={item.prUrl}
                              className="text-[12px] text-accent-text hover:underline"
                            >
                              PR #{item.prNumber} ↗
                            </ExternalLink>
                          )}
                          {item.prNumber && (
                            <MergeConfirmButton
                              prNumber={item.prNumber}
                              prUrl={item.prUrl ?? ''}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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

            {/* Missions — active work only on Home */}
            {(() => {
              // Home shows running + attention + imminent scheduled (< 24h)
              const activeMissions = missions.filter(m => m.group === 'running' || m.group === 'attention' || m.group === 'review');
              // Show all scheduled missions (not just those within 24h) so active
              // missions with infrequent cron schedules are never hidden on Home.
              const soonScheduled = missions
                .filter(m => m.group === 'scheduled')
                .sort((a, b) => (a.nextScanMins ?? Infinity) - (b.nextScanMins ?? Infinity))
                .slice(0, 3);
              const visibleMissions = [...activeMissions, ...soonScheduled];
              const completedCount = missions.filter(m => m.group === 'completed').length;
              const scheduledCount = missions.filter(m => m.group === 'scheduled').length;
              const hiddenCount = missions.length - visibleMissions.length;

              return (
                <div className="mb-8 md:mb-0">
                  <div className="flex items-center justify-between mb-4">
                    <div className="section-label">Missions</div>
                    {missions.length > 0 && (
                      <Link href="/app/missions" className="text-xs text-text-muted hover:text-text-secondary">
                        {activeMissions.length > 0
                          ? `${activeMissions.length} active`
                          : `${missions.length} total →`}
                      </Link>
                    )}
                  </div>
                  {missions.length === 0 ? (
                    <div className="border border-dashed border-border-default rounded-[10px] p-6">
                      <p className="text-[14px] text-text-secondary">
                        No missions yet. <Link href="/app/missions/new" className="text-primary hover:underline">Create one</Link> to organize your work.
                      </p>
                    </div>
                  ) : visibleMissions.length === 0 ? (
                    <div className="border border-dashed border-border-default rounded-[10px] p-4">
                      <p className="text-[13px] text-text-secondary">
                        No active missions right now.{' '}
                        <Link href="/app/missions" className="text-text-muted hover:text-text-secondary underline underline-offset-2">
                          View all {missions.length}
                        </Link>
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {(['running', 'attention', 'review', 'scheduled'] as const).map((groupKey) => {
                        const items = groupKey === 'scheduled'
                          ? soonScheduled
                          : visibleMissions.filter(m => m.group === groupKey);
                        if (items.length === 0) return null;
                        const section = SECTION_DISPLAY[groupKey];

                        return (
                          <div key={groupKey} className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="section-label-missions text-text-muted">
                                {section.label}
                              </span>
                              <span className="text-[10px] text-text-muted font-mono">{items.length}</span>
                            </div>
                            <div className="space-y-2">
                              {items.map((mission) => {
                                const healthDisplay = HEALTH_DISPLAY[mission.health];
                                const nextRun = formatNextRun(mission.nextScanMins, mission.nextRunAt);
                                const isHibernating = nextRun.urgency === 'far';

                                return (
                                  <Link
                                    key={mission.id}
                                    href={`/app/missions/${mission.id}`}
                                    className={`block card card-interactive mission-card ${GROUP_ACCENT_CLASS[groupKey]} p-4 hover:bg-[var(--card-hover)] transition-all duration-150 ${isHibernating ? 'mission-card-hibernating' : ''}`}
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
                                        <span className="text-[20px] font-semibold text-accent-text tabular-nums flex-shrink-0">
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
                                        <div className="h-[3px] bg-[rgba(255,245,230,0.06)] overflow-hidden">
                                          <div
                                            className="h-full transition-all duration-500"
                                            style={{
                                              width: `${mission.progress}%`,
                                              background: 'var(--accent)',
                                            }}
                                          />
                                        </div>
                                      </div>
                                    )}
                                    <div className="flex items-center gap-1.5 text-[11px] text-text-muted flex-wrap">
                                      {mission.workspaceName && (
                                        <>
                                          <span className="text-[10px] font-mono uppercase tracking-wide text-text-muted/80">
                                            {mission.workspaceName}
                                          </span>
                                          {(mission.totalTasks > 0 || mission.activeWorkers > 0 || nextRun.text) && (
                                            <span className="mx-0.5">&middot;</span>
                                          )}
                                        </>
                                      )}
                                      {mission.totalTasks > 0 && (
                                        <span>{mission.completedTasks}/{mission.totalTasks} tasks</span>
                                      )}
                                      {mission.activeWorkers > 0 && (
                                        <>
                                          {mission.totalTasks > 0 && <span className="mx-0.5">&middot;</span>}
                                          <span className="text-accent-text font-medium">
                                            {mission.activeWorkers} agent{mission.activeWorkers !== 1 ? 's' : ''} active
                                          </span>
                                        </>
                                      )}
                                      {mission.orchestrationMode === 'manual' && mission.nextScanMins !== null ? (
                                        <>
                                          {(mission.totalTasks > 0 || mission.activeWorkers > 0) && <span className="mx-0.5">&middot;</span>}
                                          <span className="text-text-muted">Disarmed · Run now to advance</span>
                                        </>
                                      ) : nextRun.text ? (
                                        <>
                                          {(mission.totalTasks > 0 || mission.activeWorkers > 0) && <span className="mx-0.5">&middot;</span>}
                                          <span className={nextRun.urgency === 'imminent' ? 'next-run-imminent' : isHibernating ? 'italic text-text-muted' : ''}>
                                            {nextRun.text}
                                          </span>
                                        </>
                                      ) : null}
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
                          className="text-xs text-text-muted hover:text-text-secondary min-w-0 truncate"
                        >
                          {hiddenCount > 0
                            ? `+${hiddenCount} more (${completedCount} completed, ${scheduledCount} scheduled) →`
                            : 'View all missions'}
                        </Link>
                        <Link
                          href="/app/missions/new"
                          className="text-xs text-text-muted hover:text-primary shrink-0 pl-2"
                        >
                          + New Mission
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

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
                      className="flex items-center gap-2 px-3 py-1.5 bg-[var(--card)] border border-border-strong hover:bg-surface-3 transition-colors"
                    >
                      <div
                        className={`w-5 h-5 flex items-center justify-center flex-shrink-0 border border-border-strong ${role.isActive ? 'ring-2 ring-accent/50' : ''}`}
                      >
                        <span className="text-text-primary text-[9px] font-bold">{role.name[0]?.toUpperCase()}</span>
                      </div>
                      <span className="text-[12px] font-medium text-text-primary">{role.name}</span>
                      {role.isActive && (
                        <span className="w-1.5 h-1.5 bg-accent animate-pulse" />
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
              <div className="card">
                {recentActivity.map((event, i) => {
                  const statusKey = event.type === 'completed' ? 'completed' : 'failed';

                  const row = (
                    <>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-text-primary truncate">
                          {event.title}
                        </div>
                        <div className="text-[10px] text-text-muted mt-0.5 truncate">
                          via {event.workerName}
                          {event.missionTitle && ` \u00B7 ${event.missionTitle}`}
                          {' \u00B7 '}
                          {timeAgo(event.timestamp)}
                        </div>
                      </div>
                      <div className="flex-shrink-0">
                        <StatusBadge status={statusKey} />
                      </div>
                    </>
                  );
                  const rowClass = `flex items-center gap-3 px-3 py-2.5 ${i < recentActivity.length - 1 ? 'border-b border-border-default' : ''}`;

                  return event.taskId ? (
                    <Link key={event.id} href={`/app/tasks/${event.taskId}`} className={`${rowClass} hover:bg-surface-3 transition-colors`}>
                      {row}
                    </Link>
                  ) : (
                    <div key={event.id} className={rowClass}>
                      {row}
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
