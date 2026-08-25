import { db } from '@buildd/core/db';
import { tasks, workers, missions as missionsTable, taskSchedules, workspaceSkills, workspaces as workspacesTable, missionNotes, initiativeProgressSeen } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, gte, sql, isNotNull, or, isNull, ne, like } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamIds, getTeamWorkspaceIds } from '@/lib/team-access';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';
import { Greeting } from './greeting';
import { resolvePolicy } from '@/lib/merge-policy';
import ExternalLink from '@/components/ExternalLink';
import InternalLink from '@/components/InternalLink';
import { buildActionQueue } from '@/lib/action-queue';
import type { ResolvedEscalationItem } from '@/lib/action-queue';
import { ResolvedEscalationsGroup } from '@/components/ResolvedEscalationsGroup';
import { SwipeableRow, SwipeProvider } from '@/components/SwipeableRow';
import TaskCard from '@/components/TaskCard';
import StatusBadge from '@/components/StatusBadge';
import { deriveChainPosition, deriveIntensity } from '@/lib/task-presentation';
import type { ChainPositionResult } from '@/lib/task-presentation';
import { computeMissionProgress, crossedMilestone } from '@buildd/core/mission-helpers';
import { MissionBadges } from '@/components/MissionProgress';
import { MissionProgressBar } from '@/components/MissionProgressBar';
import { InterruptReviewButton } from './InterruptReviewButton';
import { WaitingOnYouMergeCard } from '@/components/WaitingOnYouMergeCard';
import { WaitingOnYouReviewCard } from '@/components/WaitingOnYouReviewCard';
import InitiativeRail from '@/components/InitiativeRail';
import InitiativeFilterChips from '@/components/InitiativeFilterChips';
import { loadInitiativeList, type InitiativeListItem } from '@/lib/initiative-list';
import { sortInitiatives } from '@/lib/initiative-presentation';

export const dynamic = 'force-dynamic';
import {
  deriveMissionHealth,
  deriveHealth,
  healthToGroup,
  formatNextRun,
  SECTION_DISPLAY,
  GROUP_ACCENT_CLASS,
  GROUP_ORDER,
  type MissionHealth,
  type MissionGroup,
} from '@/lib/mission-helpers';
import { LIVE_WORKER_STATUSES } from '@/lib/task-timestamps';
import { selectReviewerEvidence } from '@/lib/reviewer-evidence';

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
  searchParams?: Promise<{ workspace?: string; initiative?: string }>;
}) {
  const { workspace: wsFilter, initiative: initFilter } = (await searchParams) ?? {};
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
    initiativeId: string | null;
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
    status: string;
    segments: import('@buildd/core/mission-helpers').MissionSegment[];
    healthState: import('@/lib/mission-helpers').Health;
    inFlightTasks: import('@/lib/mission-helpers').InFlightTask[];
    lastDeferralReason: string | null;
    lastDeferredAt: string | null;
    blockedPRCount: number;
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

  // Durable-arc rail — additive, above the ephemeral feed. Empty ⇒ collapses.
  let railInitiatives: InitiativeListItem[] = [];
  const RAIL_LIMIT = 6;
  // Initiatives present among the Waiting-on-you items — drives the scoping chips.
  let actionQueueInitiatives: Array<{ id: string; title: string }> = [];
  // Arc headline: an initiative that crossed a milestone since this user's last visit.
  let arcHeadline: string | null = null;

  let waitingOnYou: Array<{
    kind: 'merge' | 'approve' | 'answer';
    prUrl?: string;
    prNumber?: number;
    prLifecycleStatus?: 'open' | 'merged' | 'closed' | null;
    upstreamTaskId?: string;
    upstreamTaskTitle?: string;
    unblockCount?: number;
    taskId?: string;
    taskTitle?: string;
    workerId?: string;
    question?: string;
    missionId?: string | null;
    missionTitle?: string | null;
  }> = [];

  let escalationInbox: {
    workerId: string;
    taskId: string;
    taskTitle: string;
    workspaceId: string;
    workspaceName: string;
    prNumber: number | null;
    prUrl: string | null;
    policyTier: string;
    leaseState: 'agent_approved' | 'agent_flagged' | 'pending_human';
    escalationReason: string | null;
    verdictSummary: string | null;
    waitingMinutes: number | null;
    conflictRetryTaskId: string | null;
    conflictRetryIteration: number | null;
  }[] = [];

  let resolvedEscalations: ResolvedEscalationItem[] = [];

  let agentReviewingPrs: {
    workerId: string;
    taskId: string;
    taskTitle: string;
    prNumber: number | null;
    prUrl: string | null;
    workspaceId: string;
    workspaceName: string;
    reviewerWorkerId: string;
    reviewerRoleSlug: string | null;
    reviewerStartedAt: Date | null;
    missionId: string | null;
  }[] = [];

  let actionQueue: import('@/lib/action-queue').ActionQueueItem[] = [];

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

      // Initiative rail — team-scoped (matching the cookie/team logic above),
      // optionally narrowed by the active workspace filter. Independent of the
      // task/worker wsIds queries below so it survives an empty workspace set.
      const initiativeTeamIds = activeTeamId ? [activeTeamId] : await getUserTeamIds(user.id);
      const sortedInitiatives = sortInitiatives(
        await loadInitiativeList({
          teamIds: initiativeTeamIds,
          workspaceIdFilter: wsFilter && wsIds.includes(wsFilter) ? wsFilter : null,
        }),
      );
      railInitiatives = sortedInitiatives.slice(0, RAIL_LIMIT);
      // Map every child mission → its initiative, for the queue scoping chips.
      const missionToInitiative = new Map<string, { id: string; title: string }>();
      for (const ini of sortedInitiatives) {
        for (const m of ini.missions) missionToInitiative.set(m.id, { id: ini.id, title: ini.title });
      }

      // Arc headline — detect a milestone crossing since this user's last visit,
      // then refresh the per-user snapshot to current. A first-ever view seeds the
      // baseline silently (no snapshot ⇒ no headline).
      if (sortedInitiatives.length > 0) {
        const seenRows = await db
          .select({ initiativeId: initiativeProgressSeen.initiativeId, lastProgress: initiativeProgressSeen.lastProgress })
          .from(initiativeProgressSeen)
          .where(and(
            eq(initiativeProgressSeen.userId, user.id),
            inArray(initiativeProgressSeen.initiativeId, sortedInitiatives.map((i) => i.id)),
          ));
        const seenMap = new Map(seenRows.map((r) => [r.initiativeId, r.lastProgress]));
        let best: { title: string; milestone: number } | null = null;
        for (const ini of sortedInitiatives) {
          const prev = seenMap.get(ini.id);
          if (prev === undefined) continue; // first view → baseline only
          const m = crossedMilestone(prev, ini.progress.progress);
          if (m !== null && (!best || m > best.milestone)) best = { title: ini.title, milestone: m };
        }
        if (best) arcHeadline = `${best.title} crossed ${best.milestone}%`;

        await db
          .insert(initiativeProgressSeen)
          .values(sortedInitiatives.map((i) => ({ userId: user.id, initiativeId: i.id, lastProgress: i.progress.progress })))
          .onConflictDoUpdate({
            target: [initiativeProgressSeen.userId, initiativeProgressSeen.initiativeId],
            set: { lastProgress: sql`excluded.last_progress`, updatedAt: sql`now()` },
          });
      }

      if (wsIds.length > 0) {
        // Count total tasks to distinguish new vs returning users
        // Exclude attempt tasks (CI retries, reviewer runs) — they nest under parents.
        const totalResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(tasks)
          .where(and(inArray(tasks.workspaceId, wsIds), isNull(tasks.parentTaskId)));
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
              columns: { id: true, title: true, missionId: true, roleSlug: true, parentTaskId: true, mode: true, taskClass: true },
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
        // keep only the newest), skip bookkeeping rows (§3.6), and cap at 6 for the feed.
        const seenTasks = new Set<string>();
        recentActivity = recentWorkers
          .filter((w: any) => {
            const task = w.task;
            if (task && (task.taskClass === 'attempt' || task.taskClass === 'bookkeeping')) return false;
            const key = task?.id || w.id;
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
            columns: { id: true, title: true, description: true, initiativeId: true, status: true, orchestrationMode: true, dependsOnMissionId: true, dependencyMetAt: true },
            with: {
              tasks: {
                columns: { id: true, title: true, status: true, kind: true, mode: true, creationSource: true, category: true, parentTaskId: true, dependsOn: true, scheduleId: true, startAt: true, loopIteration: true },
                with: { workers: { columns: { status: true, startedAt: true, turns: true, prUrl: true, mergedAt: true, prNumber: true, prLifecycleStatus: true }, limit: 5 } },
              },
              schedule: { columns: { id: true, nextRunAt: true, lastRunAt: true, cronExpression: true, lastDeferralReason: true, lastDeferredAt: true, maxConcurrentFromSchedule: true } },
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

          // Build cross-mission task map for blocked-PR computation
          const homeMissionTaskMap = new Map<string, { id: string; status: string; workers: any[] }>();
          for (const m of allMissions) {
            for (const t of m.tasks) {
              homeMissionTaskMap.set(t.id, t as any);
            }
          }
          function countHomeMissionBlockedByPR(missionTasks: any[]): number {
            let count = 0;
            for (const t of missionTasks) {
              if (t.status !== 'pending') continue;
              const deps = (t.dependsOn as string[] | null) ?? [];
              for (const depId of deps) {
                const dep = homeMissionTaskMap.get(depId);
                if (!dep || dep.status !== 'completed') continue;
                const depW = dep.workers?.[0];
                if (depW?.prNumber && !depW.mergedAt && depW.prLifecycleStatus !== 'closed') {
                  count++;
                  break;
                }
              }
            }
            return count;
          }

          missions = allMissions.map(mission => {
            const { totalTasks, completedTasks, progress, segments } = computeMissionProgress(mission.tasks);
            const activeWorkers = activeWorkerCounts[mission.id] || 0;
            const nextRunAt = (mission.schedule as any)?.nextRunAt ?? null;
            const lastRunAt = (mission.schedule as any)?.lastRunAt ?? null;
            const cronExpression = (mission.schedule as any)?.cronExpression ?? null;
            const schedNextScanMins = nextRunAt
              ? Math.max(0, Math.round((new Date(nextRunAt).getTime() - Date.now()) / 60000))
              : null;

            const rawDeferralReason = (mission.schedule as any)?.lastDeferralReason ?? null;

            // Check if per-schedule concurrent cap is still exceeded; if not, clear the stale reason.
            let lastDeferralReason = rawDeferralReason;
            if (rawDeferralReason === 'concurrent_cap') {
              const schedId = (mission.schedule as any)?.id;
              const maxConcurrent: number = (mission.schedule as any)?.maxConcurrentFromSchedule ?? 1;
              const activeScheduleTasks = (mission.tasks as any[]).filter((t: any) =>
                t.scheduleId === schedId &&
                ['pending', 'assigned', 'in_progress'].includes(t.status)
              ).length;
              if (activeScheduleTasks < maxConcurrent) lastDeferralReason = null;
            }

            // Earliest future startAt of user-scheduled pending tasks (loopIteration === 0).
            const nowMs = Date.now();
            let pendingUserScheduledAt: Date | null = null;
            for (const t of mission.tasks as any[]) {
              if (t.status !== 'pending') continue;
              if ((t.loopIteration ?? 0) !== 0) continue;
              if (!t.startAt) continue;
              const ts = new Date(t.startAt).getTime();
              if (ts > nowMs && (pendingUserScheduledAt === null || ts < pendingUserScheduledAt.getTime())) {
                pendingUserScheduledAt = new Date(t.startAt);
              }
            }
            if (pendingUserScheduledAt) lastDeferralReason = null;

            const orchestrationMode = (mission as any).orchestrationMode ?? null;
            const health = deriveMissionHealth({
              status: mission.status,
              activeAgents: activeWorkers,
              cronExpression,
              lastRunAt,
              nextRunAt,
              orchestrationMode,
              pendingUserScheduledAt,
            });

            const effectiveNextRunAt = nextRunAt
              ? String(nextRunAt)
              : pendingUserScheduledAt
              ? pendingUserScheduledAt.toISOString()
              : null;
            const nextScanMins = schedNextScanMins ?? (pendingUserScheduledAt
              ? Math.max(0, Math.round((pendingUserScheduledAt.getTime() - nowMs) / 60000))
              : null);

            return {
              id: mission.id,
              title: mission.title,
              description: mission.description,
              initiativeId: mission.initiativeId ?? null,
              totalTasks,
              completedTasks,
              progress,
              activeWorkers,
              health,
              group: healthToGroup(health, progress),
              nextScanMins,
              nextRunAt: effectiveNextRunAt,
              workspaceName: (mission.workspace as any)?.name || null,
              orchestrationMode,
              status: mission.status,
              segments,
              healthState: deriveHealth(mission, mission.tasks),
              inFlightTasks: mission.tasks.flatMap(t => (t as any).workers.filter((w: any) => LIVE_WORKER_STATUSES.includes(w.status as any)).map((w: any) => ({ id: t.id, title: t.title, startedAt: w.startedAt ? String(w.startedAt) : null, turns: w.turns }))),
              lastDeferralReason,
              lastDeferredAt: (mission.schedule as any)?.lastDeferredAt ? String((mission.schedule as any).lastDeferredAt) : null,
              blockedPRCount: countHomeMissionBlockedByPR(mission.tasks as any[]),
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

        // Escalation inbox (BT-15) + agent-review lease detection
        {
          const openPrWorkers = await db.query.workers.findMany({
            where: and(
              inArray(workers.workspaceId, wsIds),
              isNotNull(workers.prUrl),
              isNull(workers.mergedAt),
              sql`COALESCE(${workers.prLifecycleStatus}, 'pr_open') NOT IN ('closed', 'merged')`,
            ),
            columns: { id: true, taskId: true, workspaceId: true, prUrl: true, prNumber: true, prLifecycleStatus: true, completedAt: true },
            with: { task: { columns: { id: true, title: true, missionId: true } } },
          });

          if (openPrWorkers.length > 0) {
            const openTaskIds = openPrWorkers.map(w => w.taskId).filter(Boolean) as string[];
            const openTaskIdSet = new Set(openTaskIds);

            // ── Reviewer lease detection ──────────────────────────────────────
            // Find active reviewer tasks (category='review') with a live worker
            // linked to our open PR tasks via context.reviewerFor.
            const reviewerLiveMap = new Map<string, {
              reviewerWorkerId: string;
              reviewerRoleSlug: string | null;
              reviewerStartedAt: Date | null;
            }>();
            if (openTaskIds.length > 0) {
              const reviewerTasksWithWorkers = await db.query.tasks.findMany({
                where: and(
                  inArray(tasks.workspaceId, wsIds),
                  eq(tasks.category, 'review'),
                  inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
                ),
                columns: { id: true, context: true, roleSlug: true },
                with: {
                  workers: {
                    where: inArray(workers.status, [...LIVE_WORKER_STATUSES]),
                    columns: { id: true, status: true, startedAt: true },
                    limit: 1,
                  },
                },
              });
              for (const rt of reviewerTasksWithWorkers) {
                const ctx = (rt.context ?? {}) as Record<string, unknown>;
                const origTaskId = ctx.reviewerFor as string | undefined;
                if (!origTaskId || !openTaskIdSet.has(origTaskId)) continue;
                const liveWorker = (rt as any).workers?.[0];
                if (liveWorker) {
                  reviewerLiveMap.set(origTaskId, {
                    reviewerWorkerId: liveWorker.id,
                    reviewerRoleSlug: rt.roleSlug ?? null,
                    reviewerStartedAt: liveWorker.startedAt ?? null,
                  });
                }
              }
            }
            // ─────────────────────────────────────────────────────────────────

            const allReviewerNotes = openTaskIds.length > 0
              ? await db.query.missionNotes.findMany({
                  where: and(
                    inArray(missionNotes.taskId, openTaskIds),
                    inArray(missionNotes.type, ['reviewer_escalated', 'reviewer_approved']),
                  ),
                  columns: { taskId: true, type: true, body: true, title: true, status: true, createdAt: true },
                })
              : [];
            const {
              escalationMap: reviewerEscalationMap,
              approvalMap: reviewerApprovalMap,
              supersededTaskIds,
            } = selectReviewerEvidence(allReviewerNotes);
            const escalatedMap = new Map(
              [...reviewerEscalationMap].map(([taskId, evidence]) => [taskId, evidence.reason]),
            );
            const approvedMap = new Map(
              [...reviewerApprovalMap].map(([taskId, evidence]) => [taskId, evidence.summary]),
            );

            const wsRowsForInbox = await db.query.workspaces.findMany({
              where: inArray(workspacesTable.id, [...new Set(openPrWorkers.map(w => w.workspaceId))]),
              columns: { id: true, name: true, gitConfig: true },
            });
            const wsInboxMap = new Map(wsRowsForInbox.map(ws => [ws.id, ws]));

            const agentReviewingTaskIds = new Set(reviewerLiveMap.keys());

            // ── Conflict retry lease detection ──────────────────────────────────
            // While a conflict-retry task is live for a PR, the card renders as
            // RESOLVING rather than asking the human to merge.
            const conflictRetryMap = new Map<string, { taskId: string; iteration: number }>();
            if (openPrWorkers.length > 0) {
              const conflictRetryTasks = await db.query.tasks.findMany({
                where: and(
                  inArray(tasks.workspaceId, wsIds),
                  sql`${tasks.creationSource} = 'conflict'`,
                  isNotNull(tasks.conflictRetryPrNumber),
                  inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
                ),
                columns: { id: true, workspaceId: true, conflictRetryPrNumber: true, context: true },
              });
              for (const t of conflictRetryTasks) {
                if (t.conflictRetryPrNumber == null) continue;
                const key = `${t.workspaceId}:${t.conflictRetryPrNumber}`;
                const ctx = (t.context ?? {}) as Record<string, unknown>;
                const iteration = typeof ctx.conflictIteration === 'number' ? ctx.conflictIteration : 1;
                conflictRetryMap.set(key, { taskId: t.id, iteration });
              }
            }
            // ───────────────────────────────────────────────────────────────────

            // Build agent-reviewing cards (shown in Right Now, not in the human queue)
            agentReviewingPrs = openPrWorkers
              .filter(w => w.taskId && agentReviewingTaskIds.has(w.taskId))
              .map(w => {
                const ws = wsInboxMap.get(w.workspaceId);
                const reviewer = reviewerLiveMap.get(w.taskId!)!;
                return {
                  workerId: w.id,
                  taskId: w.taskId ?? '',
                  taskTitle: (w.task as any)?.title ?? '',
                  prNumber: w.prNumber,
                  prUrl: w.prUrl,
                  workspaceId: w.workspaceId,
                  workspaceName: ws?.name ?? '',
                  reviewerWorkerId: reviewer.reviewerWorkerId,
                  reviewerRoleSlug: reviewer.reviewerRoleSlug,
                  reviewerStartedAt: reviewer.reviewerStartedAt,
                  missionId: (w.task as any)?.missionId ?? null,
                };
              });

            escalationInbox = openPrWorkers
              .filter(w => {
                const taskTitle = (w.task as any)?.title ?? '';
                if (taskTitle.startsWith('[smoke-test')) return false;
                if (w.taskId && supersededTaskIds.has(w.taskId)) return false;
                // Exclude while under active agent-review lease
                if (w.taskId && agentReviewingTaskIds.has(w.taskId)) return false;
                // Include if a conflict retry is live (renders as RESOLVING)
                if (w.prNumber != null && conflictRetryMap.has(`${w.workspaceId}:${w.prNumber}`)) return true;
                if (w.taskId && escalatedMap.has(w.taskId)) return true;
                if (w.taskId && approvedMap.has(w.taskId)) return true;
                const ws = wsInboxMap.get(w.workspaceId);
                if (!ws) return false;
                if (resolvePolicy(ws).tier === 'human') return true;
                // AC-6 fallback: a completed worker on an agent-review workspace whose reviewer
                // produced no signal (e.g. non-mission task, note creation was skipped).
                // Surface as UNKNOWN rather than silently dropping the row.
                if (resolvePolicy(ws).tier === 'agent-review' && w.completedAt != null) return true;
                return false;
              })
              .map(w => {
                const ws = wsInboxMap.get(w.workspaceId);
                const policy = ws ? resolvePolicy(ws) : { tier: 'auto-threshold' as const };
                const verdictSummary = (w.taskId ? approvedMap.get(w.taskId) : undefined) ?? null;
                // For approved items, surface the verdict text as the reason so the merge card
                // is informative. Escalated items already carry an escalationReason.
                const escalationReason = (w.taskId ? escalatedMap.get(w.taskId) : undefined)
                  ?? verdictSummary
                  ?? (policy.tier === 'human' ? 'Human Gate — manual merge required' : null);
                const waitingMinutes = w.completedAt
                  ? Math.round((Date.now() - new Date(w.completedAt).getTime()) / 60000)
                  : null;
                const leaseState: 'agent_approved' | 'agent_flagged' | 'pending_human' =
                  verdictSummary ? 'agent_approved'
                  : escalationReason && policy.tier !== 'human' ? 'agent_flagged'
                  : 'pending_human';
                const conflictRetry = w.prNumber != null ? conflictRetryMap.get(`${w.workspaceId}:${w.prNumber}`) : undefined;
                return {
                  workerId: w.id,
                  taskId: w.taskId ?? '',
                  taskTitle: (w.task as any)?.title ?? '',
                  workspaceId: w.workspaceId,
                  workspaceName: ws?.name ?? '',
                  prNumber: w.prNumber,
                  prUrl: w.prUrl,
                  policyTier: policy.tier,
                  leaseState,
                  escalationReason,
                  verdictSummary,
                  waitingMinutes,
                  conflictRetryTaskId: conflictRetry?.taskId ?? null,
                  conflictRetryIteration: conflictRetry?.iteration ?? null,
                };
              })
              .slice(0, 10);
          }

          // Resolved escalations: workers whose PR has since merged or closed.
          // §1.3 mobile-decision-flow: show as dimmed "Resolved" group, not inline.
          // Hard constraint: read prLifecycleStatus only — never re-derive from GitHub.
          {
            const resolvedPrWorkers = await db.query.workers.findMany({
              where: and(
                inArray(workers.workspaceId, wsIds),
                isNotNull(workers.prUrl),
                inArray(workers.prLifecycleStatus, ['merged', 'closed']),
                gte(workers.completedAt, activityWindowStart),
              ),
              columns: {
                id: true, taskId: true, workspaceId: true, prUrl: true,
                prNumber: true, prLifecycleStatus: true,
              },
              with: {
                task: { columns: { id: true, title: true, missionId: true } },
                workspace: { columns: { id: true, name: true, gitConfig: true } },
              },
              orderBy: [desc(workers.completedAt)],
              limit: 10,
            });

            if (resolvedPrWorkers.length > 0) {
              const resolvedTaskIds = resolvedPrWorkers.map(w => w.taskId).filter(Boolean) as string[];

              const resolvedNotes = resolvedTaskIds.length > 0
                ? await db.query.missionNotes.findMany({
                    where: and(
                      inArray(missionNotes.taskId, resolvedTaskIds),
                      inArray(missionNotes.type, ['reviewer_escalated', 'reviewer_approved']),
                    ),
                    columns: { taskId: true, type: true, title: true, body: true, status: true, createdAt: true },
                  })
                : [];

              const { escalationMap: rEscMap, approvalMap: rApprMap, supersededTaskIds: rSuperseded } =
                selectReviewerEvidence(resolvedNotes);

              resolvedEscalations = resolvedPrWorkers
                .filter(w => {
                  const taskTitle = (w.task as any)?.title ?? '';
                  if (taskTitle.startsWith('[smoke-test')) return false;
                  if (w.taskId && rSuperseded.has(w.taskId)) return false;
                  if (w.taskId && (rEscMap.has(w.taskId) || rApprMap.has(w.taskId))) return true;
                  const ws = (w as any).workspace;
                  if (!ws) return false;
                  return resolvePolicy(ws).tier === 'human';
                })
                .map(w => {
                  const ws = (w as any).workspace;
                  return {
                    workerId: w.id,
                    taskId: w.taskId ?? '',
                    taskTitle: (w.task as any)?.title ?? '',
                    prNumber: w.prNumber,
                    prUrl: w.prUrl,
                    prLifecycleStatus: w.prLifecycleStatus as 'merged' | 'closed',
                    workspaceName: ws?.name ?? '',
                  };
                });
            }
          }
        }

        // "Waiting on You" action queue
        {
          // 1. PR blockers: pending tasks whose upstream deps are completed but have open PRs
          const pendingWithDeps = await db
            .select({ id: tasks.id, missionId: tasks.missionId, dependsOn: tasks.dependsOn })
            .from(tasks)
            .where(and(
              inArray(tasks.workspaceId, wsIds),
              eq(tasks.status, 'pending'),
              sql`${tasks.dependsOn} IS NOT NULL AND ${tasks.dependsOn}::jsonb != '[]'::jsonb`
            ))
            .limit(300);

          if (pendingWithDeps.length > 0) {
            const upstreamIds = [...new Set(
              pendingWithDeps.flatMap(t => (t.dependsOn as string[] | null) ?? [])
            )];

            if (upstreamIds.length > 0) {
              const upstreamTasks = await db.query.tasks.findMany({
                where: and(
                  inArray(tasks.id, upstreamIds),
                  eq(tasks.status, 'completed'),
                ),
                columns: { id: true, title: true, missionId: true },
                with: {
                  workers: {
                    where: and(
                      isNotNull(workers.prUrl),
                      isNull(workers.mergedAt),
                    ),
                    columns: { prUrl: true, prNumber: true, prLifecycleStatus: true },
                    orderBy: desc(workers.createdAt),
                    limit: 1,
                  },
                  mission: { columns: { id: true, title: true } },
                },
              });

              // Load mission titles for the downstream blocked tasks
              const downstreamMissionIds = [...new Set(
                pendingWithDeps.map(t => t.missionId).filter(Boolean) as string[]
              )];
              const downstreamMissionMap = new Map<string, string>();
              if (downstreamMissionIds.length > 0) {
                const missionRows = await db
                  .select({ id: missionsTable.id, title: missionsTable.title })
                  .from(missionsTable)
                  .where(inArray(missionsTable.id, downstreamMissionIds));
                for (const m of missionRows) downstreamMissionMap.set(m.id, m.title);
              }

              for (const upstream of upstreamTasks) {
                const w = (upstream.workers as any[])[0];
                if (!w?.prNumber) continue;

                const blockedTasks = pendingWithDeps.filter(t =>
                  ((t.dependsOn as string[]) ?? []).includes(upstream.id)
                );
                if (blockedTasks.length === 0) continue;

                // Determine which mission(s) the blocked tasks belong to
                const blockedMissionIds = [...new Set(
                  blockedTasks.map(t => t.missionId).filter(Boolean) as string[]
                )];
                const missionTitle = blockedMissionIds.length === 1
                  ? (downstreamMissionMap.get(blockedMissionIds[0]) ?? (upstream.mission as any)?.title ?? null)
                  : null;

                waitingOnYou.push({
                  kind: 'merge',
                  prUrl: w.prUrl,
                  prNumber: w.prNumber,
                  prLifecycleStatus: (w.prLifecycleStatus as 'open' | 'merged' | 'closed' | null) ?? null,
                  upstreamTaskId: upstream.id,
                  upstreamTaskTitle: upstream.title,
                  unblockCount: blockedTasks.length,
                  missionId: blockedMissionIds[0] ?? null,
                  missionTitle,
                });
              }

              // Sort merge items by unblock fan-out (most impactful first)
              waitingOnYou.sort((a, b) => (b.unblockCount ?? 0) - (a.unblockCount ?? 0));
            }
          }

          // 2. Unanswered worker questions (waiting_input with waitingFor set)
          const waitingInputWorkers = await db.query.workers.findMany({
            where: and(
              inArray(workers.workspaceId, wsIds),
              eq(workers.status, 'waiting_input'),
              isNotNull(workers.waitingFor),
            ),
            columns: { id: true, taskId: true, waitingFor: true },
            with: {
              task: {
                columns: { id: true, title: true, missionId: true },
                with: { mission: { columns: { id: true, title: true } } },
              },
            },
            limit: 5,
          });
          for (const w of waitingInputWorkers) {
            const wf = w.waitingFor as { type: string; prompt: string } | null;
            if (!wf?.prompt) continue;
            waitingOnYou.push({
              kind: 'answer',
              workerId: w.id,
              taskId: (w.task as any)?.id ?? '',
              taskTitle: (w.task as any)?.title ?? '',
              question: wf.prompt,
              missionId: (w.task as any)?.missionId ?? null,
              missionTitle: (w.task as any)?.mission?.title ?? null,
            });
          }

          // 3. Pending plan approvals: planning tasks completed with plan, not yet approved
          const planningTaskRows = await db.query.tasks.findMany({
            where: and(
              inArray(tasks.workspaceId, wsIds),
              eq(tasks.mode, 'planning'),
              eq(tasks.status, 'completed'),
              isNotNull(tasks.result),
            ),
            columns: { id: true, title: true, missionId: true, result: true },
            with: { mission: { columns: { id: true, title: true } } },
            orderBy: desc(tasks.updatedAt),
            limit: 10,
          });
          if (planningTaskRows.length > 0) {
            // Check which planning tasks already have child tasks (already approved)
            const planIds = planningTaskRows.map(t => t.id);
            const childRows = await db
              .select({ parentTaskId: tasks.parentTaskId })
              .from(tasks)
              .where(inArray(tasks.parentTaskId, planIds));
            const approvedPlanIds = new Set(
              childRows.map(r => r.parentTaskId).filter(Boolean) as string[]
            );
            for (const t of planningTaskRows) {
              if (approvedPlanIds.has(t.id)) continue;
              const plan = (t.result as any)?.structuredOutput?.plan;
              if (!Array.isArray(plan) || plan.length === 0) continue;
              waitingOnYou.push({
                kind: 'approve',
                taskId: t.id,
                taskTitle: t.title,
                missionId: t.missionId,
                missionTitle: (t.mission as any)?.title ?? null,
              });
            }
          }
        }

        // Merge waitingOnYou + escalationInbox into one deduplicated action queue
        actionQueue = buildActionQueue(waitingOnYou, escalationInbox);

        // Tag each item with its mission's initiative and collect the distinct
        // initiatives present (sorted, blocked-first) for the scoping chips.
        actionQueue = actionQueue.map((item) => {
          const ini = item.missionId ? missionToInitiative.get(item.missionId) : undefined;
          return ini ? { ...item, initiativeId: ini.id, initiativeTitle: ini.title } : item;
        });
        const presentInitiativeIds = new Set(
          actionQueue.map((i) => i.initiativeId).filter(Boolean) as string[],
        );
        actionQueueInitiatives = sortedInitiatives
          .filter((i) => presentInitiativeIds.has(i.id))
          .map((i) => ({ id: i.id, title: i.title }));

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
  // Arc-aware subheading: overnight throughput + the actionable "waiting on you"
  // count (the milestone, when one crossed, leads as the headline above).
  const shipClause = completedLast12h > 0
    ? `${completedLast12h} ship${completedLast12h === 1 ? '' : 's'} ${timePeriod}`
    : null;
  // RESOLVING items are informational — agent is handling it, not the human.
  const actionableCount = actionQueue.filter(i => i.chip !== 'RESOLVING').length;
  const waitClause = actionableCount > 0 ? `${actionableCount} waiting on you` : null;
  const subParts = [shipClause, waitClause].filter(Boolean) as string[];
  const subheading = subParts.length > 0 ? subParts.join(' · ') : 'Your agents are standing by';

  // Chips SCOPE the Waiting-on-you queue (never group it). The section still
  // gates on the unfiltered queue so a filter that empties it doesn't hide the
  // chips (leaving the user unable to clear the filter).
  const filteredActionQueue = initFilter
    ? actionQueue.filter((i) => i.initiativeId === initFilter)
    : actionQueue;

  return (
    <SwipeProvider>
    <main className="min-h-screen pt-14 px-4 pb-20 md:pt-8 md:px-8 md:pb-8">
      <div className="max-w-5xl mx-auto">
        {/* Workspace filter — desktop only; mobile header owns the picker */}
        {teamWorkspaces.length > 0 && (
          <div className="hidden md:flex justify-end mb-4">
            <WorkspaceFilter workspaces={teamWorkspaces} selectedId={wsFilter ?? null} />
          </div>
        )}
        {/* Desktop two-column layout */}
        <div className="md:flex md:gap-0">
          {/* Left column: Greeting + Right Now */}
          <div className="md:w-[60%] md:pr-8">
            {/* Greeting — replaced by an arc headline when an initiative crossed
                a milestone since the user's last visit. */}
            <div className="mb-8 md:mb-10">
              {arcHeadline ? (
                <h1 className="text-[28px] font-semibold text-text-primary leading-tight uppercase tracking-tight">
                  {arcHeadline}
                </h1>
              ) : (
                <Greeting firstName={firstName} />
              )}
              <p className="text-[15px] text-text-secondary font-light mt-1.5">
                {subheading}
              </p>
            </div>

            {/* Durable-arc rail — above the ephemeral feed; collapses when empty. */}
            <InitiativeRail initiatives={railInitiatives} />

            {/* Waiting on You — unified action queue (MERGE · REVIEW · QUESTION · APPROVE · RESOLVING) */}
            {actionQueue.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center justify-between mb-4">
                  <div className="section-label">Waiting on You</div>
                  {/* Badge excludes RESOLVING — those are agent-handled, not human tasks */}
                  {filteredActionQueue.filter(i => i.chip !== 'RESOLVING').length > 0 && (
                    <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[11px] font-bold rounded-full bg-primary text-white">
                      {filteredActionQueue.filter(i => i.chip !== 'RESOLVING').length}
                    </span>
                  )}
                </div>
                {/* Initiative scoping chips — SCOPE the queue, never group it. */}
                <InitiativeFilterChips
                  initiatives={actionQueueInitiatives}
                  selectedId={initFilter ?? null}
                  workspaceFilter={wsFilter ?? null}
                />
                {filteredActionQueue.length === 0 && (
                  <p className="text-[13px] text-text-muted mb-2">Nothing waiting for this initiative.</p>
                )}
                <div className="space-y-2">
                  {filteredActionQueue.map((item) => {
                    if (item.chip === 'MERGE') {
                      return (
                        <SwipeableRow
                          key={item.subjectKey}
                          cardType="gate-card"
                          taskTitle={item.taskTitle ?? `PR #${item.prNumber}`}
                          prUrl={item.prUrl}
                        >
                          <WaitingOnYouMergeCard item={item} />
                        </SwipeableRow>
                      );
                    }
                    if (item.chip === 'REVIEW') {
                      return (
                        <SwipeableRow
                          key={item.subjectKey}
                          cardType="gate-card"
                          taskTitle={item.taskTitle ?? `PR #${item.prNumber}`}
                          prUrl={item.prUrl}
                        >
                          <WaitingOnYouReviewCard item={item} />
                        </SwipeableRow>
                      );
                    }
                    if (item.chip === 'QUESTION') {
                      return (
                        <Link
                          key={item.subjectKey}
                          href={`/app/tasks/${item.taskId}`}
                          className="block border-l-2 border-status-warning bg-status-warning/5 rounded-r-[10px] px-4 py-3 hover:bg-status-warning/10 transition-colors"
                        >
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] font-mono font-medium text-status-warning tracking-wide uppercase">
                              Question
                            </span>
                            {item.missionTitle && (
                              <span className="text-[11px] text-text-muted">{item.missionTitle}</span>
                            )}
                          </div>
                          <div className="text-[13px] font-medium text-text-primary truncate mb-0.5">
                            {item.taskTitle}
                          </div>
                          <p className="text-[12px] text-text-secondary line-clamp-2">{item.question}</p>
                        </Link>
                      );
                    }
                    if (item.chip === 'APPROVE') {
                      return (
                        <Link
                          key={item.subjectKey}
                          href={`/app/tasks/${item.taskId}`}
                          className="block border-l-2 border-accent bg-accent/5 rounded-r-[10px] px-4 py-3 hover:bg-accent/10 transition-colors"
                        >
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] font-mono font-medium text-accent-text tracking-wide uppercase">
                              Approve Plan
                            </span>
                            {item.missionTitle && (
                              <span className="text-[11px] text-text-muted">{item.missionTitle}</span>
                            )}
                          </div>
                          <div className="text-[13px] font-medium text-text-primary truncate">
                            {item.taskTitle}
                          </div>
                        </Link>
                      );
                    }
                    if (item.chip === 'RESOLVING') {
                      return (
                        <div
                          key={item.subjectKey}
                          className="border-l-2 border-text-muted bg-surface-2 rounded-r-[10px] px-4 py-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                                <span className="inline-flex items-center gap-1 text-[10px] font-mono font-medium text-text-muted tracking-wide uppercase">
                                  <span className="w-2 h-2 rounded-full border border-text-muted border-t-transparent animate-spin inline-block" />
                                  Resolving Conflicts
                                  {item.conflictRetryIteration != null && ` · attempt ${item.conflictRetryIteration}`}
                                </span>
                              </div>
                              {item.taskTitle && (
                                <div className="text-[13px] font-medium text-text-primary truncate mt-0.5">
                                  {item.conflictRetryTaskId ? (
                                    <Link href={`/app/tasks/${item.conflictRetryTaskId}`} className="hover:underline">
                                      {item.taskTitle}
                                    </Link>
                                  ) : item.taskId ? (
                                    <Link href={`/app/tasks/${item.taskId}`} className="hover:underline">
                                      {item.taskTitle}
                                    </Link>
                                  ) : item.taskTitle}
                                </div>
                              )}
                              {item.prUrl && (
                                <a
                                  href={item.prUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[11px] text-text-muted hover:underline mt-0.5 inline-block"
                                >
                                  PR #{item.prNumber} ↗
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
                {resolvedEscalations.length > 0 && (
                  <ResolvedEscalationsGroup items={resolvedEscalations} />
                )}
              </div>
            )}
            {actionQueue.length === 0 && activeItems.length > 0 && (
              <div className="mb-8">
                <div className="section-label mb-3">Waiting on You</div>
                <p className="text-[13px] text-text-muted">Nothing waiting on you — all in-flight work is autonomous.</p>
                {resolvedEscalations.length > 0 && (
                  <ResolvedEscalationsGroup items={resolvedEscalations} />
                )}
              </div>
            )}

            {/* Right Now */}
            <div className="mb-8">
              <div className="section-label mb-4">Right Now</div>
              {activeItems.length === 0 && agentReviewingPrs.length === 0 && teamWorkspaces.length === 0 ? (
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
              ) : activeItems.length === 0 && agentReviewingPrs.length === 0 && totalTaskCount === 0 ? (
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
              ) : activeItems.length === 0 && agentReviewingPrs.length === 0 ? (
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
                  {/* Agent-reviewing PR cards — ambient presence, not actionable */}
                  {agentReviewingPrs.map((item) => (
                    <div
                      key={item.reviewerWorkerId}
                      className="border border-border-default rounded-[10px] px-4 py-3 bg-surface-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                            <span className="text-[10px] font-mono font-medium text-text-muted tracking-wide uppercase">
                              Agent Reviewing
                            </span>
                            {item.reviewerRoleSlug && (
                              <span className="text-[10px] text-text-muted">· {item.reviewerRoleSlug}</span>
                            )}
                            {item.reviewerStartedAt && (
                              <span className="text-[10px] text-text-muted">
                                {timeAgo(item.reviewerStartedAt)}
                              </span>
                            )}
                          </div>
                          <Link
                            href={`/app/tasks/${item.taskId}`}
                            className="text-[13px] font-medium text-text-primary truncate hover:underline block"
                          >
                            {item.taskTitle}
                          </Link>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            {item.workspaceName && (
                              <span className="text-[11px] text-text-muted">{item.workspaceName}</span>
                            )}
                            {item.prUrl && (
                              <ExternalLink href={item.prUrl} className="text-[11px] text-text-muted hover:underline">
                                PR #{item.prNumber} ↗
                              </ExternalLink>
                            )}
                          </div>
                        </div>
                        <InterruptReviewButton workerId={item.reviewerWorkerId} />
                      </div>
                    </div>
                  ))}
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
                      {(['review', 'running', 'attention', 'scheduled'] as const).map((groupKey) => {
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
                                const nextRun = formatNextRun(mission.nextScanMins, mission.nextRunAt);
                                const isHibernating = nextRun.urgency === 'far';

                                return (
                                  <div
                                    key={mission.id}
                                    className={`block card card-interactive mission-card ${GROUP_ACCENT_CLASS[groupKey]} p-4 hover:bg-[var(--card-hover)] transition-all duration-150 ${isHibernating ? 'mission-card-hibernating' : ''}`}
                                  >
                                    <div className="flex items-start justify-between gap-3 mb-1.5">
                                      <div className="flex items-center gap-2 min-w-0">
                                        <Link href={`/app/missions/${mission.id}`} className="text-[15px] font-medium text-text-primary truncate hover:text-accent-text">
                                          {mission.title}
                                        </Link>
                                      </div>
                                    </div>
                                    {mission.description && (
                                      <p className="text-[12px] text-text-secondary mb-2 line-clamp-1">
                                        {mission.description}
                                      </p>
                                    )}
                                    <MissionBadges mission={mission} health={mission.healthState} nextRun={nextRun} isReviewReady={groupKey === 'review'} />
                                    {mission.totalTasks > 0 && <div className="my-2"><MissionProgressBar density="full" missionId={mission.id} segments={mission.segments} completedTasks={mission.completedTasks} totalTasks={mission.totalTasks} inFlightTasks={mission.inFlightTasks} /></div>}
                                    <div className="flex items-center gap-1.5 text-[11px] text-text-muted flex-wrap">
                                      {mission.workspaceName && (
                                        <>
                                          <span className="text-[10px] font-mono uppercase tracking-wide text-text-muted/80">
                                            {mission.workspaceName}
                                          </span>
                                          {(mission.activeWorkers > 0 || mission.blockedPRCount > 0) && (
                                            <span className="mx-0.5">&middot;</span>
                                          )}
                                        </>
                                      )}
                                      {mission.activeWorkers > 0 && (
                                        <span className="text-accent-text font-medium">
                                          {mission.activeWorkers} agent{mission.activeWorkers !== 1 ? 's' : ''} active
                                        </span>
                                      )}
                                      {mission.blockedPRCount > 0 && (
                                        <>
                                          {mission.activeWorkers > 0 && <span className="mx-0.5">&middot;</span>}
                                          <InternalLink
                                            href="/app/home"
                                            className="text-primary font-medium hover:underline"
                                          >
                                            blocked on {mission.blockedPRCount} PR{mission.blockedPRCount !== 1 ? 's' : ''}
                                          </InternalLink>
                                        </>
                                      )}
                                    </div>
                                  </div>
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
    </SwipeProvider>
  );
}
