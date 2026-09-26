import { db } from '@buildd/core/db';
import { tasks, workers, missions as missionsTable, taskSchedules, workspaceSkills, workspaces as workspacesTable, teams as teamsTable, missionNotes, initiativeProgressSeen, secrets, connectors, actionQueueSnoozes, specDiscrepancies } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, gte, gt, sql, isNotNull, or, isNull, ne, like } from 'drizzle-orm';
import { detectArchetype } from '@buildd/core/release-archetype';
import type { ReleaseReadinessItem } from '@/lib/release-readiness';
import { ReleaseWidget } from './ReleaseWidget';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamScope } from '@/lib/team-access';
import { splitWaitingOnYou, rightNowState, recordBestEffort } from './home-view';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';
import { resolvePolicy, isMissionIntegrationBase } from '@/lib/merge-policy';
import { noRowOfPrMerged, oneRowPerPr } from '@/lib/pr-merge-stamp';
import { guardMissionPrMerge } from '@/lib/mission-pr';
import { isMissionPrTask } from '@buildd/core/mission-integration';
import ExternalLink from '@/components/ExternalLink';
import { buildActionQueue, buildDecideItems, buildDiscrepancyItems, summariseActionQueueAge } from '@/lib/action-queue';
import { inferCriteriaFailureReading, describeCriteriaFailureReading } from '@/lib/criteria-rearm';
import { actionCardTaskLink } from '@/lib/action-card-context';
import { missionTaskHref } from '@/lib/mission-task-href';
import { resolveCiGate } from '@/lib/ci-gate';
import { DEFAULT_MAX_CI_RETRIES } from '@/lib/ci-retry';
import type { CiGate, PrLifecycle } from '@/lib/ci-gate';
import type { ResolvedEscalationItem, WaitingOnYouRawItem } from '@/lib/action-queue';
import { needsReconnect } from '@/lib/connector-status';
import { refreshStaleWorkersForWorkspaces } from '@/lib/pr-state-refresh';
import { DEFAULT_MAX_CONFLICT_ITERATIONS } from '@/lib/conflict-retry';
import { derivedValue, derivedUnavailable } from '@buildd/core/derived-metric';
import { resolveGatedReleaseState } from '@/lib/release-baseline';
import { notMissionIntegrationMerge } from '@buildd/core/release-queue-scope';
import { ResolvedEscalationsGroup } from '@/components/ResolvedEscalationsGroup';
import { SwipeProvider } from '@/components/SwipeableRow';
import { deriveChainPosition, deriveIntensity } from '@/lib/task-presentation';
import type { ChainPositionResult, ChainPositionDep } from '@/lib/task-presentation';
import { crossedMilestone } from '@buildd/core/mission-helpers';
import { InterruptReviewButton } from './InterruptReviewButton';
import HomeAutoRefresh from './HomeAutoRefresh';
import InitiativeFilterChips from '@/components/InitiativeFilterChips';
import { loadInitiativeList } from '@/lib/initiative-list';
import { sortInitiatives } from '@/lib/initiative-presentation';
import {
  loadInitiativeEffort,
  loadInitiativeVerdictInputs,
  deriveInitiativeVerdict,
  derivePendingCounts,
  countBlockedByPR,
  emptyVerdictRollup,
  zeroEffortWindow,
  noPendingCounts,
  type EffortDay,
  type VerdictRollup,
  type BlockingTask,
} from '@/lib/initiative-pulse';
import type { PulseLineItem } from '@/lib/initiative-pulse-line';
import { InitiativePulseLine } from './InitiativePulseLine';
import { loadShippedMissionIds } from '@/lib/mission-ship-state';

export const dynamic = 'force-dynamic';
import { LIVE_WORKER_STATUSES, LIVE_TASK_STATUSES } from '@/lib/task-presentation';
import {
  summarizeMissionForCard,
  type MissionCardRow,
  type MissionCardSummary,
  type MissionCardView,
} from '@/lib/mission-card-view';
import { loadMissionCardViews, MISSION_CARD_TASK_COLUMNS, MISSION_CARD_WORKERS_WITH } from '@/lib/mission-card-views';
import type { HomeMissionSummary } from './HomeMissions';
import { selectReviewerEvidence } from '@/lib/reviewer-evidence';
import { resolveReviewerGate, deriveStoredVerdictFallback, gateReachesActionQueue } from '@/lib/reviewer-gate';
import type { ReviewerTaskStatus } from '@/lib/reviewer-gate';
import { createReviewerStallFactsLoader } from '@/lib/reviewer-stall-facts';
import { ActionQueueCard } from './ActionQueueCard';
import { StatStrip } from './StatStrip';
import { FleetStrip } from './FleetStrip';
import { ActivityTicker } from './ActivityTicker';
import { NeedsYouStack, type HomeShippedMission } from './NeedsYouStack';
import type { HomeHeldMission, HomeQuestion } from './NeedsYouCards';
import { HomeMissionsSummary, type HomeMissionRow } from './HomeMissionsSummary';
import { loadHomeFleet, type HomeFleetData } from '@/lib/home-fleet';
import { homeHeadline, startOfDayInZone } from '@/lib/fleet-view';
import { buildMissionListCard, shortAgo, type ListMissionRow } from '@/lib/mission-list-card';
import { buildMissionCardView as buildHomeCardView } from '@/lib/mission-card-view';
import { missionTaskHref as homeTaskHref } from '@/lib/mission-task-href';

// --- Helpers ---

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

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ workspace?: string; initiative?: string }>;
}) {
  const { workspace: wsFilter, initiative: initFilter } = (await searchParams) ?? {};
  const user = await getCurrentUser();

  const isDev = process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL); // placeholder unless dev has a DB + dev user

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

  let missions: HomeMissionSummary[] = [];

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
  // Every workspace of the active team — the empty-state input. Not the
  // filter list's length alone, and not narrowed by ?workspace=.
  let workspaceCount = 0;
  // Workspace channels HomeAutoRefresh subscribes to, so an open tab never
  // holds a stale action queue (e.g. a Merge card for an already-merged PR).
  let refreshWorkspaceIds: string[] = [];

  // Initiatives present among the Waiting-on-you items — drives the scoping chips.
  let actionQueueInitiatives: Array<{ id: string; title: string }> = [];
  // Arc headline: an initiative that crossed a milestone since this user's last visit.
  let arcHeadline: string | null = null;
  // One verdict per initiative, feeding the one-line initiative pulse (§2 of
  // docs/specs/surface-ia-home-missions-initiatives.md). Stays empty when every
  // arc is winning/dormant/empty, and the line then renders as absence.
  let pulseItems: PulseLineItem[] = [];

  const waitingOnYou: WaitingOnYouRawItem[] = [];

  let escalationInbox: {
    workerId: string;
    taskId: string;
    taskTitle: string;
    workspaceId: string;
    workspaceName: string;
    prNumber: number | null;
    prUrl: string | null;
    policyTier: string;
    missionId: string | null;
    missionTitle: string | null;
    ciGate: CiGate | null;
    recommendation: string | null;
    leaseState: 'agent_approved' | 'agent_flagged' | 'pending_human';
    escalationReason: string | null;
    /** See EscalationRawItem.hasEscalationNote — an open reviewer_escalated note exists. */
    hasEscalationNote: boolean;
    verdictSummary: string | null;
    /** The SHA the latest reviewer verdict was made against, if any. */
    approvedSha: string | null;
    /** The PR's current head — compared against approvedSha on the card. */
    headSha: string | null;
    waitingMinutes: number | null;
    conflictRetryTaskId: string | null;
    conflictRetryIteration: number | null;
    /** Freshness inputs — buildActionQueue refuses a merge CTA on stale state. */
    prLifecycleStatus: string | null;
    prOpenedAt: Date | null;
    prLifecycleVerifiedAt: Date | null;
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
    unblockCount: number | null;
    upstreamTaskTitle: string | null;
  }[] = [];

  // PRs whose reviewer task exists but hasn't been claimed yet — the agent
  // still owns the next move, so these render in-flight, not in Waiting on You.
  let reviewQueuedPrs: {
    taskId: string;
    taskTitle: string;
    prNumber: number | null;
    prUrl: string | null;
    workspaceId: string;
    workspaceName: string;
    missionId: string | null;
    reason: string | null;
    unblockCount: number | null;
    upstreamTaskTitle: string | null;
  }[] = [];

  // Per-original-task reviewer gate decision, keyed by taskId — computed once
  // in the escalation-inbox block below, consulted again by the dependency
  // (PR blockers) section so a PR under active/queued review never gets a
  // second, human-facing MERGE card there.
  let reviewerGateMap = new Map<string, import('@/lib/reviewer-gate').ReviewerGateResult>();

  let actionQueue: import('@/lib/action-queue').ActionQueueItem[] = [];
  // Open discrepancy rows beyond each workspace's visible top-10 (§12) — never
  // silently dropped, always surfaced as a count alongside the capped cards.
  let discrepancyOverflowCount = 0;

  let releaseReadinessItems: ReleaseReadinessItem[] = [];

  // The fleet redesign: runner snapshot, ticker, stat counts (lib/home-fleet.ts),
  // the compact missions rows and the Needs-you stack's own cards.
  let fleetData: HomeFleetData | null = null;
  let homeMissionRows: HomeMissionRow[] = [];
  let heldMissions: HomeHeldMission[] = [];
  let shippedMissions: HomeShippedMission[] = [];
  let missionTotal = 0;
  let shippedToday = 0;
  let teamName: string | null = null;
  let teamTz: string | null = null;
  const renderNow = Date.now();

  // Build a roles map for display
  const rolesMap = new Map<string, { name: string; color: string }>();

  if (!isDev) {
    if (!user) {
      redirect('/app/auth/signin');
    }

    try {
      const cookieStore = await cookies();
      // Same resolver as the app shell (layout.tsx), so the team the header
      // names is the team whose workspaces Home shows: valid cookie → personal
      // team → first team. No cookie is no longer a cross-team view.
      const scope = await resolveActiveTeamScope(user.id, cookieStore.get('buildd-team')?.value);
      const activeTeamId = scope.teamId;
      teamWorkspaces = scope.workspaces;
      const teamWsIds = scope.workspaces.map((w) => w.id);
      // Narrow to selected workspace if filter is set (must belong to team)
      const wsIds = (wsFilter && teamWsIds.includes(wsFilter)) ? [wsFilter] : teamWsIds;
      workspaceCount = teamWsIds.length;
      refreshWorkspaceIds = wsIds;

      // Initiative list — team-scoped (matching the cookie/team logic above),
      // optionally narrowed by the active workspace filter. Independent of the
      // task/worker wsIds queries below so it survives an empty workspace set.
      // Feeds the arc headline and the queue scoping chips; the 160px card rail
      // it used to feed is MUST NOT on Home (surface-IA spec §1, §2.1, AC-6).
      const initiativeTeamIds = activeTeamId ? [activeTeamId] : [];
      const sortedInitiatives = sortInitiatives(
        await loadInitiativeList({
          teamIds: initiativeTeamIds,
          workspaceIdFilter: wsFilter && wsIds.includes(wsFilter) ? wsFilter : null,
          // The pulse line's `stuck` clause needs held / blocked / awaiting-merge
          // counts, which `derivePendingCounts` reads off these mission rows. No
          // extra round trip — the same relational query carries the columns.
          pendingSignals: true,
        }),
      );
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

        // Bookkeeping, not rendering: runs after the response via after(), and
        // a failure only costs the next visit its headline. Awaited here it
        // could throw and skip every query below, blanking Home.
        const seenValues = sortedInitiatives.map((i) => ({ userId: user.id, initiativeId: i.id, lastProgress: i.progress.progress }));
        recordBestEffort('initiative-progress-seen', () => db
          .insert(initiativeProgressSeen)
          .values(seenValues)
          .onConflictDoUpdate({
            target: [initiativeProgressSeen.userId, initiativeProgressSeen.initiativeId],
            set: { lastProgress: sql`excluded.last_progress`, updatedAt: sql`now()` },
          }));
      }

      // Initiative pulse line (§2.2): one verdict per arc, from the shared
      // loader — never a second query of our own, and never a call per
      // initiative (§2.4, §6.2). Effort and verdict evidence are team-scoped on
      // purpose (§6.5): a workspace-narrowed window would let the sidebar filter
      // flip an arc's verdict.
      if (sortedInitiatives.length > 0) {
        const effortByInitiative = new Map<string, EffortDay[]>();
        const rollupByInitiative = new Map<string, VerdictRollup>();
        await Promise.all(
          initiativeTeamIds.map(async (teamId) => {
            const [effort, rollups] = await Promise.all([
              loadInitiativeEffort({ teamId }),
              loadInitiativeVerdictInputs({ teamId }),
            ]);
            for (const [id, days] of effort) effortByInitiative.set(id, days);
            for (const [id, rollup] of rollups) rollupByInitiative.set(id, rollup);
          }),
        );

        // `dependsOn` crosses mission boundaries, so the blocking index spans
        // every mission loaded rather than being rebuilt per initiative.
        const blockingIndex = new Map<string, BlockingTask>();
        for (const ini of sortedInitiatives) {
          for (const mission of ini.missions) {
            for (const task of mission.tasks ?? []) blockingIndex.set(task.id, task);
          }
        }

        // Ship state, not the mission.status row transition (docs/design/mission-delivery-arc.md,
        // "The missing dimension: ship state") — one batched query for every
        // mission on the page, not one per mission.
        const allMissionIds = sortedInitiatives.flatMap((ini) => ini.missions.map((m) => m.id));
        const shippedMissionIds = await loadShippedMissionIds(allMissionIds);

        pulseItems = sortedInitiatives.map((ini) => {
          const rollup = rollupByInitiative.get(ini.id) ?? emptyVerdictRollup(ini.status);
          const effortDays = effortByInitiative.get(ini.id) ?? zeroEffortWindow();
          const counts =
            derivePendingCounts(
              ini.missions.map((mission) => ({
                initiativeId: ini.id,
                isHeld: mission.isHeld,
                shipped: shippedMissionIds.has(mission.id),
                lastActivityAt: mission.updatedAt,
                blockedPRCount: countBlockedByPR(mission.tasks ?? [], blockingIndex),
                tasks: mission.tasks ?? [],
              })),
            ).get(ini.id) ?? noPendingCounts();

          const { verdict } = deriveInitiativeVerdict({ rollup, effortDays, counts });
          return { id: ini.id, title: ini.title, verdict };
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

        // Active workers with their tasks and objectives
        const activeWorkers = await db.query.workers.findMany({
          where: and(
            inArray(workers.workspaceId, wsIds),
            inArray(workers.status, [...LIVE_WORKER_STATUSES])
          ),
          orderBy: desc(workers.createdAt),
          // No cap: every live worker is a fleet slot, and a cap hid the 11th.
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
        const depTaskInfoMap = new Map<string, ChainPositionDep>();
        if (allDepIds.length > 0) {
          const depTasks = await db.query.tasks.findMany({
            where: inArray(tasks.id, allDepIds),
            // title → readable rail chips; dependsOn → transitive reduction.
            columns: { id: true, title: true, status: true, dependsOn: true },
            with: {
              workers: {
                // No limit: the gate asks "does ANY worker hold an open PR?".
                // prLifecycleStatus: a closed/abandoned PR unblocks dependents.
                columns: { prUrl: true, prNumber: true, mergedAt: true, prLifecycleStatus: true },
                orderBy: (w: any, { desc: d }: any) => [d(w.startedAt)],
              },
            },
          });
          for (const dt of depTasks) {
            depTaskInfoMap.set(dt.id, {
              id: dt.id,
              title: dt.title,
              status: dt.status,
              dependsOn: (dt.dependsOn as string[] | null) ?? [],
              workers: dt.workers.map((w: any) => ({
                prUrl: w.prUrl ?? null,
                prNumber: w.prNumber ?? null,
                mergedAt: w.mergedAt ? String(w.mergedAt) : null,
                prLifecycleStatus: w.prLifecycleStatus ?? null,
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
          const resolvedDeps = depIds
            .map((id: string) => depTaskInfoMap.get(id))
            .filter(Boolean) as ChainPositionDep[];
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

        // Read-through PR state refresh: catch missed merge webhooks before
        // querying openPrWorkers (Waiting on You) and the fleet ticker.
        await refreshStaleWorkersForWorkspaces(wsIds).catch(err =>
          console.error('[home] pr-state-refresh failed (non-fatal):', err),
        );

        // 30-day recency window for the resolved-escalations group below.
        const activityWindowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        // Missions with task progress + health
        // Scope: the active team (wsIds is non-empty, so there is one).
        {
          const missionTeamIds = activeTeamId ? [activeTeamId] : [];

          const missionsWhere = missionTeamIds.length > 0
            ? (wsFilter && activeTeamId
                ? and(
                    eq(missionsTable.teamId, activeTeamId),
                    or(eq(missionsTable.workspaceId, wsFilter), isNull(missionsTable.workspaceId)),
                  )
                : inArray(missionsTable.teamId, missionTeamIds))
            : undefined;

          // Exclude archived missions: they can never be active/scheduled on Home.
          // Columns are the card's (lib/mission-card-views.ts) so the visible
          // cards cost no second task fan-out.
          const allMissions = missionsWhere ? await db.query.missions.findMany({
            where: and(missionsWhere, ne(missionsTable.status, 'archived')),
            orderBy: [desc(missionsTable.priority), desc(missionsTable.createdAt)],
            columns: { id: true, title: true, description: true, initiativeId: true, status: true, orchestrationMode: true, dependsOnMissionId: true, dependencyMetAt: true, criteriaEscalatedAt: true, isHeld: true, startAt: true, goalCriteria: true, goalCriteriaState: true, completedAt: true, workingBranch: true, integrationBranchEnabled: true, createdAt: true, updatedAt: true },
            with: {
              tasks: {
                columns: MISSION_CARD_TASK_COLUMNS,
                with: { workers: MISSION_CARD_WORKERS_WITH },
              },
              schedule: { columns: { id: true, nextRunAt: true, lastRunAt: true, cronExpression: true, lastDeferralReason: true, lastDeferredAt: true, maxConcurrentFromSchedule: true, totalRuns: true } },
              workspace: { columns: { id: true, name: true } },
            },
          }) : [];

          // Cross-mission task index: `dependsOn` crosses mission boundaries.
          const homeMissionTaskMap = new Map<string, BlockingTask>();
          for (const m of allMissions) {
            for (const t of m.tasks) homeMissionTaskMap.set(t.id, t as BlockingTask);
          }

          // Every mission is summarised (group, schedule timing) so the section
          // counts are right; only the visible ones pay for a full card view.
          // Group is healthToGroup and live workers are LIVE_WORKER_STATUSES —
          // the same builder the missions list uses (AC-14, D8).
          // The nested workers are capped per task, so live workers are an
          // exact batched count, not a count of the loaded rows.
          const liveWorkerCounts = new Map<string, number>();
          if (allMissions.length > 0) {
            const liveRows = await db
              .select({ missionId: tasks.missionId, n: sql<number>`count(distinct ${workers.id})::int` })
              .from(workers)
              .innerJoin(tasks, eq(workers.taskId, tasks.id))
              .where(and(
                inArray(tasks.missionId, allMissions.map(m => m.id)),
                inArray(workers.status, [...LIVE_WORKER_STATUSES]),
              ))
              .groupBy(tasks.missionId);
            for (const r of liveRows) if (r.missionId) liveWorkerCounts.set(r.missionId, r.n);
          }

          const nowMs = Date.now();
          const summaries = new Map<string, MissionCardSummary>();
          for (const m of allMissions) {
            summaries.set(m.id, summarizeMissionForCard(m as MissionCardRow, {
              now: nowMs, liveWorkers: liveWorkerCounts.get(m.id) ?? 0,
            }));
          }
          missions = allMissions.map(m => ({
            id: m.id,
            group: summaries.get(m.id)!.group,
            nextScanMins: summaries.get(m.id)!.nextScanMins,
          }));

          // Fleet redesign: compact rows (running, recurring, shipped in the
          // last 12h), held missions for the Needs-you stack, and the one that
          // just shipped. Same list-card model the missions list uses.
          const recentMs = 12 * 3_600_000;
          const recurringIds = allMissions.filter(m => (m.schedule as any)?.cronExpression && m.status !== 'completed').map(m => m.id);
          const lastTickSummary = new Map<string, string>();
          if (recurringIds.length > 0) {
            const tickRows = await db
              .selectDistinctOn([tasks.missionId], { missionId: tasks.missionId, summary: sql<string | null>`${tasks.result}->>'summary'` })
              .from(tasks)
              .where(and(inArray(tasks.missionId, recurringIds), isNotNull(tasks.scheduleId), eq(tasks.status, 'completed')))
              .orderBy(tasks.missionId, desc(tasks.createdAt));
            for (const r of tickRows) if (r.missionId && r.summary) lastTickSummary.set(r.missionId, r.summary);
          }
          missionTotal = allMissions.length;
          const listed = allMissions.flatMap(m => {
            const summary = summaries.get(m.id)!;
            const recurring = recurringIds.includes(m.id);
            const recentDone = m.status === 'completed' && m.completedAt && nowMs - new Date(m.completedAt).getTime() < recentMs;
            const live = summary.liveWorkers > 0 || ['running', 'attention', 'review'].includes(summary.group);
            if (!recurring && !recentDone && !live && !m.isHeld) return [];
            const row = m as unknown as ListMissionRow;
            if (recurring) {
              const last = lastTickSummary.get(m.id);
              const lastTick = (row.tasks ?? []).filter(t => t.scheduleId && t.status === 'completed')
                .sort((a, b) => new Date(b.createdAt as any).getTime() - new Date(a.createdAt as any).getTime())[0];
              if (last && lastTick) (lastTick as any).result = { summary: last };
            }
            const view = buildHomeCardView(row, { from: 'home', now: nowMs, summary, taskIndex: homeMissionTaskMap });
            const model = buildMissionListCard(row, view, summary, { now: nowMs });
            return [{ view, model, completedAt: m.completedAt }];
          });
          homeMissionRows = listed
            .filter(r => r.model.kind === 'active' || r.model.kind === 'recurring' || r.model.kind === 'done')
            .sort((a, b) => ({ active: 0, recurring: 1, done: 2 } as Record<string, number>)[a.model.kind] - ({ active: 0, recurring: 1, done: 2 } as Record<string, number>)[b.model.kind])
            .slice(0, 6)
            .map(({ view, model }) => ({ view, model }));
          heldMissions = listed.filter(r => r.model.kind === 'held').map(({ view, model }) => ({
            id: view.id, title: view.title, href: view.href,
            ready: model.held?.ready ?? 0, roles: model.held?.roles ?? [],
            done: model.counts.done, total: model.counts.total,
            heldFor: model.held?.since ? shortAgo(model.held.since, nowMs) : null,
          }));
          const done = listed.filter(r => r.model.kind === 'done');
          shippedToday = done.length;
          shippedMissions = done
            .filter(r => r.completedAt && nowMs - new Date(r.completedAt).getTime() < 3 * 3_600_000)
            .slice(0, 1)
            .map(({ view, model }) => ({
              id: view.id, title: view.title, href: view.href, completedAt: view.completedAt!,
              prs: model.done?.prs ?? 0, fixes: model.done?.fixes ?? 0, durationMs: model.done?.durationMs ?? null,
              criteria: model.criteria,
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

        // Release queue readiness — gated workspaces only (spec §8 exception rule).
        // Uses DB-only sources for speed: queue depth from workers, CI state from
        // the most recent releases row. No GitHub API calls at home-page load.
        {
          const wsRows = await db
            .select({
              id: workspacesTable.id,
              name: workspacesTable.name,
              releaseConfig: workspacesTable.releaseConfig,
              gitConfig: workspacesTable.gitConfig,
            })
            .from(workspacesTable)
            .where(inArray(workspacesTable.id, wsIds));

          const gatedWsIds = wsRows
            .filter(
              (ws) =>
                detectArchetype({
                  name: ws.name,
                  releaseConfig: ws.releaseConfig as any,
                  gitConfig: ws.gitConfig as any,
                }) === 'gated',
            )
            .map((ws) => ws.id);

          if (gatedWsIds.length > 0) {
            releaseReadinessItems = await Promise.all(
              gatedWsIds.map(async (wsId) => {
                const ws = wsRows.find((w) => w.id === wsId)!;

                // Baseline + CI reading (@buildd/core/release-baseline via
                // resolveGatedReleaseState): healthy release → deployed release →
                // any non-failed release → prod-branch HEAD. A failed dispatch
                // establishes neither a baseline nor a CI reading, and a reading
                // past its TTL degrades to unknown rather than pinning to a stale
                // failure. Shared with the readiness route so no two release
                // surfaces can disagree about where the queue starts.
                const { baseline, ciState, latestReleaseId, commitsAheadAtDispatch } = await resolveGatedReleaseState(wsId);

                if (!baseline.asOf) {
                  return {
                    workspaceId: wsId,
                    workspaceName: ws.name,
                    queueDepth: derivedUnavailable<number>('no_baseline'),
                    oldestMergedAt: derivedUnavailable<string>('no_baseline'),
                    baselineSource: baseline.source,
                    ciState,
                    latestReleaseId,
                    commitsAheadAtDispatch,
                  };
                }

                const [queueRow] = await db
                  .select({
                    queueDepth: sql<number>`count(*)::int`,
                    oldestMergedAt: sql<string | null>`min(${workers.mergedAt})::text`,
                  })
                  .from(workers)
                  .innerJoin(tasks, eq(tasks.id, workers.taskId))
                  .where(
                    and(
                      eq(tasks.workspaceId, wsId),
                      isNotNull(workers.mergedAt),
                      sql`${workers.mergedAt} > ${baseline.asOf}::timestamptz`,
                      // A merge into a mission integration branch is not on
                      // trunk — see core/release-queue-scope.
                      notMissionIntegrationMerge(),
                    ),
                  );

                return {
                  workspaceId: wsId,
                  workspaceName: ws.name,
                  queueDepth: derivedValue(queueRow?.queueDepth ?? 0),
                  oldestMergedAt: queueRow?.oldestMergedAt
                    ? derivedValue(queueRow.oldestMergedAt)
                    : derivedUnavailable<string>('no_scope'),
                  baselineSource: baseline.source,
                  ciState,
                  latestReleaseId,
                  commitsAheadAtDispatch,
                };
              }),
            );
          }
        }

        // Escalation inbox (BT-15) + agent-review lease detection
        {
          // One PR can sit on several worker rows (a CI-retry attempt adopts
          // its parent's PR). A merge seen by any of them means the PR merged,
          // and the rest collapse to the owner row: one PR, one card.
          const openPrWorkers = oneRowPerPr(await db.query.workers.findMany({
            where: and(
              inArray(workers.workspaceId, wsIds),
              isNotNull(workers.prUrl),
              isNull(workers.mergedAt),
              noRowOfPrMerged(),
              sql`COALESCE(${workers.prLifecycleStatus}, 'pr_open') NOT IN ('closed', 'merged', 'unresolvable')`,
            ),
            columns: {
              id: true, taskId: true, workspaceId: true, prUrl: true, prNumber: true,
              prLifecycleStatus: true, completedAt: true,
              // Freshness inputs for the action-queue invariant: how old the PR
              // is (which tier it falls in) and when its state was last verified.
              createdAt: true, prLastVerifiedAt: true,
              // When the lifecycle was last written: a just-green auto-merge PR
              // is still merging (see resolveReviewerGate).
              updatedAt: true,
              // Where this PR points. Needed by resolvePolicy to tell a task PR
              // into a mission integration branch (no human gate — the gate is on
              // the mission PR) from a PR into trunk (gate applies).
              prBaseRef: true,
              // The PR's current head — compared against the terminal verdict's
              // headSha to decide whether "Re-review changes since approval" has
              // anything new to review.
              lastCommitSha: true,
            },
            with: {
              task: {
                columns: { id: true, title: true, taskClass: true, missionId: true, status: true, requiresReview: true, result: true },
                with: { mission: { columns: { id: true, title: true, mergePolicy: true, requiresReview: true, workingBranch: true, integrationBranchEnabled: true } } },
              },
            },
          }));

          if (openPrWorkers.length > 0) {
            const openTaskIds = openPrWorkers.map(w => w.taskId).filter(Boolean) as string[];

            // ── Reviewer task lookup ────────────────────────────────────────────
            // The reviewer gate needs the CURRENT state of each original task's
            // most recent reviewer task — pending/running means the agent still
            // owns this PR; only failed/cancelled/absent-when-none-will-come means
            // it falls to the human. parentTaskId is a real column (set at
            // createReviewerTask), so this is a direct join, not a context scan.
            const latestReviewerTaskByOrigId = new Map<string, {
              id: string;
              status: string;
              hasLiveWorker: boolean;
              createdAt: Date;
              roleSlug: string | null;
              reviewerWorkerId: string | null;
              reviewerStartedAt: Date | null;
              context: Record<string, unknown> | null;
              // The reviewer task's own stored result — the SAME row `get_pr_review`
              // reads via `derivePrReviewStatus`. Carried through so the gate can fall
              // back to the actual verdict when no mission note recorded one (see the
              // gate-building loop below): a mission-less PR never gets a
              // reviewer_approved/reviewer_escalated note (handleReviewerOutcomeIfNeeded
              // only writes those `if (missionId)`), and reading only the notes made a
              // mission-less terminal approve indistinguishable from a genuinely dropped
              // verdict.
              result: unknown;
              startAt: Date | null;
              mission: { status: string } | null;
            }>();
            if (openTaskIds.length > 0) {
              const reviewerTasksRaw = await db.query.tasks.findMany({
                where: and(
                  inArray(tasks.parentTaskId, openTaskIds),
                  eq(tasks.category, 'review'),
                ),
                columns: { id: true, parentTaskId: true, status: true, roleSlug: true, createdAt: true, context: true, result: true, startAt: true },
                with: {
                  mission: { columns: { status: true } },
                  workers: {
                    where: inArray(workers.status, [...LIVE_WORKER_STATUSES]),
                    columns: { id: true, status: true, startedAt: true },
                    limit: 1,
                  },
                },
                orderBy: [desc(tasks.createdAt)],
              });
              // orderBy desc → first row seen per parentTaskId is the latest.
              for (const rt of reviewerTasksRaw) {
                if (!rt.parentTaskId || latestReviewerTaskByOrigId.has(rt.parentTaskId)) continue;
                const liveWorker = (rt as any).workers?.[0];
                latestReviewerTaskByOrigId.set(rt.parentTaskId, {
                  id: rt.id,
                  status: rt.status,
                  hasLiveWorker: !!liveWorker,
                  createdAt: rt.createdAt,
                  roleSlug: rt.roleSlug ?? null,
                  reviewerWorkerId: liveWorker?.id ?? null,
                  reviewerStartedAt: liveWorker?.startedAt ?? null,
                  context: rt.context,
                  result: rt.result,
                  startAt: rt.startAt,
                  mission: rt.mission,
                });
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
            // Distinguishes "an open reviewer_escalated note exists" (an agent
            // handed this PR back with a concrete statement, dispatchable even
            // without a structured recommendation) from resolveReviewerGate's
            // other human-actor reasons, which are pure task-status inference
            // with no statement to dispatch against. See EscalationRawItem.hasEscalationNote.
            const escalationNoteTaskIds = new Set(reviewerEscalationMap.keys());
            // The reviewer's own advice on what the human should do next.
            const reviewerRecommendationMap = new Map(
              [...reviewerEscalationMap]
                .filter(([, evidence]) => evidence.recommendation)
                .map(([taskId, evidence]) => [taskId, evidence.recommendation as string]),
            );
            const approvedMap = new Map(
              [...reviewerApprovalMap].map(([taskId, evidence]) => [taskId, evidence.summary]),
            );

            const wsRowsForInbox = await db.query.workspaces.findMany({
              where: inArray(workspacesTable.id, [...new Set(openPrWorkers.map(w => w.workspaceId))]),
              columns: { id: true, name: true, gitConfig: true, teamId: true, maxConcurrentTasks: true },
            });
            const wsInboxMap = new Map(wsRowsForInbox.map(ws => [ws.id, ws]));

            // ── Reviewer gate ────────────────────────────────────────────────────
            // Single predicate (resolveReviewerGate) deciding, per PR, whether the
            // agent still owns the next move or it has genuinely fallen to the
            // human. Both the in-flight cards and the escalation inbox below read
            // from this one map so they can never disagree.
            const gateNow = new Date();
            const stallFactsLoader = createReviewerStallFactsLoader(gateNow);
            // The mission-aware tier each gate was resolved with, so the card
            // built below reports the same tier its gate decided on.
            const policyTierByTaskId = new Map<string, string>();
            for (const w of openPrWorkers) {
              if (!w.taskId) continue;
              const ws = wsInboxMap.get(w.workspaceId);
              const mission = (w.task as any)?.mission ?? null;
              const policy = ws
                ? resolvePolicy(
                    ws,
                    mission,
                    { requiresReview: (w.task as any)?.requiresReview },
                    { baseRef: w.prBaseRef },
                  )
                : { tier: 'auto-threshold' as const };
              policyTierByTaskId.set(w.taskId, policy.tier);
              const rt = latestReviewerTaskByOrigId.get(w.taskId);
              // Mission notes never exist for a mission-less PR
              // (handleReviewerOutcomeIfNeeded writes reviewer_approved /
              // reviewer_escalated `if (missionId)` only) — fall back to the
              // reviewer task's own stored verdict, the SAME row `get_pr_review`
              // reads via `derivePrReviewStatus`, so a mission-less terminal
              // approve/request-changes/escalate is never indistinguishable from a
              // genuinely dropped verdict. See deriveStoredVerdictFallback.
              const fallback = deriveStoredVerdictFallback({
                escalationReason: escalatedMap.get(w.taskId) ?? null,
                approvalSummary: approvedMap.get(w.taskId) ?? null,
                reviewerTask: rt ? { status: rt.status as ReviewerTaskStatus, result: rt.result, context: rt.context } : null,
                currentHeadSha: w.lastCommitSha ?? null,
              });
              if (fallback.escalationReason != null) escalatedMap.set(w.taskId, fallback.escalationReason);
              if (fallback.approvalSummary != null) approvedMap.set(w.taskId, fallback.approvalSummary);
              reviewerGateMap.set(w.taskId, resolveReviewerGate({
                policyTier: policy.tier,
                escalationReason: escalatedMap.get(w.taskId) ?? null,
                approvalSummary: approvedMap.get(w.taskId) ?? null,
                reviewerTask: rt
                  ? { status: rt.status as any, hasLiveWorker: rt.hasLiveWorker, createdAt: rt.createdAt, context: rt.context, startAt: rt.startAt }
                  : null,
                queuedThresholdMinutes: policy.stallNotifyMinutes,
                stallFacts: ws && !rt?.hasLiveWorker && gateNow.getTime() - (rt?.createdAt ?? w.completedAt ?? gateNow).getTime() > (policy.stallNotifyMinutes ?? 30) * 60_000
                  ? await stallFactsLoader.load(ws, rt ?? {})
                  : undefined,
                prOpenedAt: w.completedAt ?? null,
                now: gateNow,
                // Under auto-threshold this decides "auto-merge still pending"
                // (in flight) vs "auto-merge was held" (needs you).
                prLifecycleStatus: w.prLifecycleStatus ?? null,
                prLifecycleUpdatedAt: w.updatedAt ?? null,
                // Option A′: the tier drop in resolvePolicy is also what removes
                // the reviewer, and "no reviewer will ever run" otherwise reads
                // as "a human must merge this" — the exact inverse of the intent.
                // The gate needs the base-ref fact itself, not just its shadow
                // in the tier. Authoritative predicate, because the mission row
                // (workingBranch + integrationBranchEnabled) is selected above.
                isMissionIntegrationTaskPr: isMissionIntegrationBase({
                  baseRef: w.prBaseRef,
                  mission,
                }),
              }));
            }
            // ─────────────────────────────────────────────────────────────────────

            // ── Mission-PR merge gate ───────────────────────────────────────────
            // A mission's own integration PR ("Ship mission: ..." bookkeeping task)
            // can look reviewer-approved and still be refused by `guardMissionPrMerge`
            // at merge time — the reviewer gate above and the merge gate are two
            // different questions (review state vs. "is this mission's work
            // finished"), and only the merge route consulted the second one. Ask it
            // here too, at card-build time, so the card never advertises a merge the
            // gate was always going to refuse. Read fresh on every request — same
            // "no persisted flag" rule the header comment states for QUESTION/DECIDE,
            // and the reason this doubles as the fix for a stale refusal outliving
            // the state it described (once the blocking PRs land, the next render
            // simply stops setting this).
            const missionPrGateMap = new Map<string, string | null>();
            for (const w of openPrWorkers) {
              if (!w.taskId || !w.task) continue;
              if (!isMissionPrTask(w.task)) continue;
              const gate = await guardMissionPrMerge(w.task);
              missionPrGateMap.set(w.taskId, gate.blocks ? gate.reason : null);
            }
            // ─────────────────────────────────────────────────────────────────────

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

            // ── CI fix-attempt detection ────────────────────────────────────────
            // A red PR is only waiting on the human once no [CI Retry] agent is
            // left working on it (lib/ci-retry.ts). Attempts chain parent→child,
            // so they are matched on context.prNumber rather than parentTaskId.
            const ciAttemptMap = new Map<string, {
              liveTaskId: string | null;
              liveIteration: number | null;
              attemptsConsumed: number;
              recommendation: string | null;
            }>();
            {
              const ciPrNumbers = [...new Set(
                openPrWorkers.map(w => w.prNumber).filter((n): n is number => n != null),
              )];
              if (ciPrNumbers.length > 0) {
                const attemptTasks = await db.query.tasks.findMany({
                  where: and(
                    inArray(tasks.workspaceId, wsIds),
                    eq(tasks.taskClass, 'attempt'),
                    sql`(${tasks.context}->>'prNumber') IN (${sql.join(
                      ciPrNumbers.map(n => sql`${String(n)}`),
                      sql`, `,
                    )})`,
                  ),
                  columns: { id: true, workspaceId: true, status: true, context: true, result: true },
                  orderBy: [desc(tasks.createdAt)],
                });
                for (const t of attemptTasks) {
                  const ctx = (t.context ?? {}) as Record<string, unknown>;
                  const prNumber = Number(ctx.prNumber);
                  if (!Number.isFinite(prNumber)) continue;
                  const key = `${t.workspaceId}:${prNumber}`;
                  const entry = ciAttemptMap.get(key) ?? {
                    liveTaskId: null, liveIteration: null, attemptsConsumed: 0, recommendation: null,
                  };
                  const iteration = typeof ctx.iteration === 'number' ? ctx.iteration : null;
                  if ((LIVE_TASK_STATUSES as readonly string[]).includes(t.status)) {
                    // Rows arrive newest-first, so the first live row is the current attempt.
                    if (!entry.liveTaskId) {
                      entry.liveTaskId = t.id;
                      entry.liveIteration = iteration;
                    }
                  } else {
                    // context.iteration is the retry budget counter — foreign-push
                    // retries deliberately do not advance it, so max() is the
                    // number of attempts actually charged to the agent.
                    entry.attemptsConsumed = Math.max(entry.attemptsConsumed, iteration ?? 0);
                    const suggestion = (t.result as { nextSuggestion?: string } | null)?.nextSuggestion;
                    if (!entry.recommendation && suggestion) entry.recommendation = suggestion;
                  }
                  ciAttemptMap.set(key, entry);
                }
              }
            }
            // ─────────────────────────────────────────────────────────────────────

            // ── Dead zone exhausted detection ────────────────────────────────────
            // Workers where: task is terminal + PR went dirty (prLifecycleStatus='conflict')
            // + no active conflict retry + 3 retries already done → BLOCKED card.
            const deadZoneExhaustedMap = new Map<string, { lastRetryTaskId: string | null }>();

            const terminalConflictWorkers = openPrWorkers.filter(w => {
              if (w.prLifecycleStatus !== 'conflict' || w.prNumber == null) return false;
              if (conflictRetryMap.has(`${w.workspaceId}:${w.prNumber}`)) return false;
              const taskStatus = (w.task as any)?.status as string | undefined;
              return taskStatus != null && ['completed', 'failed', 'cancelled'].includes(taskStatus);
            });

            if (terminalConflictWorkers.length > 0) {
              const tcPrNumbers = terminalConflictWorkers.map(w => w.prNumber).filter(Boolean) as number[];
              const allRetries = await db.query.tasks.findMany({
                where: and(
                  inArray(tasks.workspaceId, wsIds),
                  inArray(tasks.conflictRetryPrNumber, tcPrNumbers),
                ),
                columns: { id: true, workspaceId: true, conflictRetryPrNumber: true, status: true },
                orderBy: [desc(tasks.createdAt)],
              });

              for (const w of terminalConflictWorkers) {
                if (!w.prNumber) continue;
                const retries = allRetries.filter(
                  t => t.workspaceId === w.workspaceId && t.conflictRetryPrNumber === w.prNumber,
                );
                const completedRetries = retries.filter(t =>
                  ['completed', 'failed', 'cancelled'].includes(t.status),
                );
                if (completedRetries.length >= DEFAULT_MAX_CONFLICT_ITERATIONS) {
                  deadZoneExhaustedMap.set(w.id, { lastRetryTaskId: completedRetries[0]?.id ?? null });
                }
              }
            }
            // ─────────────────────────────────────────────────────────────────────

            // Build in-flight cards (shown in Right Now, not in the human queue):
            // 'reviewing' when a reviewer worker is live, 'queued' when a reviewer
            // task exists (or will shortly) but hasn't been claimed yet.
            agentReviewingPrs = openPrWorkers
              .filter(w => w.taskId && reviewerGateMap.get(w.taskId)?.agentState === 'reviewing')
              .map(w => {
                const ws = wsInboxMap.get(w.workspaceId);
                const rt = latestReviewerTaskByOrigId.get(w.taskId!);
                return {
                  workerId: w.id,
                  taskId: w.taskId ?? '',
                  taskTitle: (w.task as any)?.title ?? '',
                  prNumber: w.prNumber,
                  prUrl: w.prUrl,
                  workspaceId: w.workspaceId,
                  workspaceName: ws?.name ?? '',
                  reviewerWorkerId: rt?.reviewerWorkerId ?? '',
                  reviewerRoleSlug: rt?.roleSlug ?? null,
                  reviewerStartedAt: rt?.reviewerStartedAt ?? null,
                  missionId: (w.task as any)?.missionId ?? null,
                  unblockCount: null as number | null,
                  upstreamTaskTitle: null as string | null,
                };
              });

            reviewQueuedPrs = openPrWorkers
              .filter(w => w.taskId && reviewerGateMap.get(w.taskId)?.agentState === 'queued')
              .map(w => {
                const ws = wsInboxMap.get(w.workspaceId);
                return {
                  taskId: w.taskId ?? '',
                  taskTitle: (w.task as any)?.title ?? '',
                  prNumber: w.prNumber,
                  prUrl: w.prUrl,
                  workspaceId: w.workspaceId,
                  workspaceName: ws?.name ?? '',
                  missionId: (w.task as any)?.missionId ?? null,
                  reason: reviewerGateMap.get(w.taskId!)?.reason ?? 'review queued',
                  unblockCount: null as number | null,
                  upstreamTaskTitle: null as string | null,
                };
              });

            escalationInbox = openPrWorkers
              .filter(w => {
                const taskTitle = (w.task as any)?.title ?? '';
                if (taskTitle.startsWith('[smoke-test')) return false;
                if (w.taskId && supersededTaskIds.has(w.taskId)) return false;
                // Include if a conflict retry is live (renders as RESOLVING)
                if (w.prNumber != null && conflictRetryMap.has(`${w.workspaceId}:${w.prNumber}`)) return true;
                // Dead zone exhausted — all retries failed, PR needs human action (BLOCKED)
                if (deadZoneExhaustedMap.has(w.id)) return true;
                // Otherwise: the reviewer gate is the single source of truth for
                // whether this PR has genuinely fallen to the human. PENDING or
                // RUNNING reviewer work (gate.actor === 'agent') is excluded here —
                // it renders in the in-flight surface above instead.
                // An orphaned worker (taskId null — e.g. its task was deleted) has
                // no reviewer gate entry; fall back to the tier check directly
                // rather than silently dropping a PR that may need a human.
                if (!w.taskId) {
                  const ws = wsInboxMap.get(w.workspaceId);
                  return !!ws && resolvePolicy(ws).tier === 'human';
                }
                // Human-owned PRs, plus auto-merge PRs as in-flight cards.
                return gateReachesActionQueue(reviewerGateMap.get(w.taskId));
              })
              .map(w => {
                const ws = wsInboxMap.get(w.workspaceId);
                // The tier the gate resolved (mission-aware), not the workspace
                // default: a mission's own mergePolicy is what decides the card.
                const policy = {
                  tier: (w.taskId ? policyTierByTaskId.get(w.taskId) : undefined)
                    ?? (ws ? resolvePolicy(ws).tier : 'auto-threshold'),
                };
                const gate = w.taskId ? reviewerGateMap.get(w.taskId) : undefined;
                const verdictSummary = (w.taskId ? approvedMap.get(w.taskId) : undefined) ?? null;
                // The SHA the most recent reviewer task's verdict was made
                // against — set at createReviewerTask time, so it is present on
                // any completed reviewer task regardless of verdict. Compared
                // against the PR's current head to gate "Re-review changes
                // since approval" — a terminal verdict at the current head has
                // nothing new to re-review.
                const rt = w.taskId ? latestReviewerTaskByOrigId.get(w.taskId) : undefined;
                const approvedShaRaw = rt?.context && typeof rt.context === 'object'
                  ? (rt.context as Record<string, unknown>).headSha
                  : undefined;
                const approvedSha = typeof approvedShaRaw === 'string' ? approvedShaRaw : null;
                const waitingMinutes = w.completedAt
                  ? Math.round((Date.now() - new Date(w.completedAt).getTime()) / 60000)
                  : null;
                const leaseState: 'agent_approved' | 'agent_flagged' | 'pending_human' =
                  verdictSummary ? 'agent_approved'
                  : gate?.reason && policy.tier !== 'human' ? 'agent_flagged'
                  : 'pending_human';
                const conflictRetry = w.prNumber != null ? conflictRetryMap.get(`${w.workspaceId}:${w.prNumber}`) : undefined;
                const deadZoneInfo = deadZoneExhaustedMap.get(w.id);
                const ciAttempts = w.prNumber != null ? ciAttemptMap.get(`${w.workspaceId}:${w.prNumber}`) : undefined;
                const ciGate = resolveCiGate({
                  prLifecycleStatus: w.prLifecycleStatus as PrLifecycle,
                  liveFixTaskId: ciAttempts?.liveTaskId ?? null,
                  liveFixIteration: ciAttempts?.liveIteration ?? null,
                  maxCiRetries: ws?.gitConfig?.maxCiRetries ?? DEFAULT_MAX_CI_RETRIES,
                  attemptsConsumed: ciAttempts?.attemptsConsumed ?? 0,
                  recommendation: ciAttempts?.recommendation
                    ?? ((w.task as any)?.result?.nextSuggestion ?? null),
                });
                return {
                  workerId: w.id,
                  taskId: w.taskId ?? '',
                  taskTitle: (w.task as any)?.title ?? '',
                  workspaceId: w.workspaceId,
                  workspaceName: ws?.name ?? '',
                  prNumber: w.prNumber,
                  prUrl: w.prUrl,
                  policyTier: policy.tier,
                  autoMerge: gate?.platformState === 'auto_merge',
                  missionId: (w.task as any)?.missionId ?? null,
                  missionTitle: (w.task as any)?.mission?.title ?? null,
                  ciGate,
                  // CI block leads with the fixing agent's handoff; otherwise the
                  // reviewer's recommendation is what the human needs to read.
                  recommendation: ciGate?.kind === 'blocked'
                    ? ciGate.recommendation
                    : (w.taskId ? reviewerRecommendationMap.get(w.taskId) ?? null : null),
                  leaseState,
                  escalationReason: deadZoneInfo
                    ? `Agents failed ${DEFAULT_MAX_CONFLICT_ITERATIONS} conflict-resolution attempts. Resolve the conflict yourself.`
                    : (gate?.reason ?? null),
                  // Dead-zone (conflict retries exhausted) has its own dedicated
                  // CTA set below and is never sourced from a reviewer note —
                  // keep it out of the fix-dispatch branch even if a stale
                  // escalation note happens to also be open for the same task.
                  hasEscalationNote: !deadZoneInfo && !!w.taskId && escalationNoteTaskIds.has(w.taskId),
                  verdictSummary,
                  approvedSha,
                  headSha: w.lastCommitSha ?? null,
                  waitingMinutes,
                  conflictRetryTaskId: conflictRetry?.taskId ?? null,
                  conflictRetryIteration: conflictRetry?.iteration ?? null,
                  deadZoneExhausted: !!deadZoneInfo,
                  deadZoneLastRetryTaskId: deadZoneInfo?.lastRetryTaskId ?? null,
                  // Read from persisted columns only (I-9): the sweep owns all
                  // GitHub resolution, this layer only judges how old that
                  // resolution is.
                  prLifecycleStatus: w.prLifecycleStatus ?? null,
                  prOpenedAt: w.completedAt ?? w.createdAt ?? null,
                  prLifecycleVerifiedAt: w.prLastVerifiedAt ?? null,
                  missionMergeBlockedReason: w.taskId ? missionPrGateMap.get(w.taskId) ?? null : null,
                };
              })
              .sort((a, b) => {
                // In-flight cards sort last so the slice below never drops a
                // card that needs the human in favour of one that does not.
                const handled = (i: { ciGate?: { kind: string } | null; autoMerge?: boolean }) =>
                  (i.ciGate?.kind === 'fixing' || i.ciGate?.kind === 'running' || (i.autoMerge && !i.ciGate) ? 1 : 0);
                const handledDiff = handled(a) - handled(b);
                if (handledDiff !== 0) return handledDiff;
                const arcDiff = Number(!!b.missionId) - Number(!!a.missionId);
                if (arcDiff !== 0) return arcDiff;
                return (a.waitingMinutes ?? 0) - (b.waitingMinutes ?? 0);
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
                      // A sibling row (e.g. a CI-retry attempt) may be the one
                      // that recorded the merge.
                      noRowOfPrMerged(),
                    ),
                    columns: {
                      prUrl: true, prNumber: true, prLifecycleStatus: true,
                      // Freshness inputs — a blocker-derived merge card is still
                      // a claim that this PR is open right now.
                      completedAt: true, createdAt: true, prLastVerifiedAt: true,
                    },
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

                // The reviewer gate (computed above from the same open-PR-worker
                // universe) decides who this PR is actually waiting on. A pending
                // or running reviewer task means the agent still owns it — the
                // dependency urgency is real, but the actor isn't the human, so it
                // belongs on the in-flight card, not a Waiting on You MERGE card.
                //
                // `!== 'human'` rather than `=== 'agent'`: an Option A′ task PR is
                // owned by the platform, which merges it unattended, so the
                // dependency urgency is real but there is nothing to ask a human
                // for. It has no in-flight card either (no reviewer is running),
                // so it correctly renders nowhere at all.
                const gate = reviewerGateMap.get(upstream.id);
                if (gate && gate.actor !== 'human') {
                  const inFlightCard = agentReviewingPrs.find(c => c.taskId === upstream.id)
                    ?? reviewQueuedPrs.find(c => c.taskId === upstream.id);
                  if (inFlightCard) {
                    inFlightCard.unblockCount = blockedTasks.length;
                    inFlightCard.upstreamTaskTitle = upstream.title;
                  }
                  continue;
                }

                waitingOnYou.push({
                  kind: 'merge',
                  prUrl: w.prUrl,
                  prNumber: w.prNumber,
                  prLifecycleStatus: (w.prLifecycleStatus as 'open' | 'merged' | 'closed' | 'unresolvable' | null) ?? null,
                  prOpenedAt: w.completedAt ?? w.createdAt ?? null,
                  prLifecycleVerifiedAt: w.prLastVerifiedAt ?? null,
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

        // 4. Connector credentials that can no longer re-authorise themselves.
        // Scoped to the active team rather than to wsIds, since connectors are a
        // team resource. Such a connector silently starves every task that needs
        // it, and the only prior signal was the badge on the Connections page —
        // you had to already suspect something to go look. Deliberately NOT
        // "expiring soon": the refresh sweep renews those (connector-status.ts).
        if (initiativeTeamIds.length > 0) {
          const credentialRows = await db.query.secrets.findMany({
            where: and(
              inArray(secrets.teamId, initiativeTeamIds),
              eq(secrets.purpose, 'mcp_connector_credential'),
            ),
            columns: {
              label: true,
              tokenExpiresAt: true,
              lastVerificationError: true,
            },
          });
          const stale = credentialRows.filter(c => c.label && needsReconnect(c));
          if (stale.length > 0) {
            // `label` holds the connector id (see /api/connectors).
            const connectorRows = await db.query.connectors.findMany({
              where: inArray(connectors.id, stale.map(c => c.label as string)),
              columns: { id: true, name: true },
            });
            const nameById = new Map(connectorRows.map(c => [c.id, c.name]));
            for (const cred of stale) {
              const connectorName = nameById.get(cred.label as string);
              if (!connectorName) continue; // orphaned credential — connector deleted
              waitingOnYou.push({
                kind: 'reconnect',
                connectorId: cred.label as string,
                connectorName,
              });
            }
          }
        }

        // 5. Missions whose goal-criteria gate escalated to the owner. Visible
        // here is the whole point — the mission itself renders as though it
        // were running normally (deriveMissionHealth reads its own escalated
        // state, but nothing surfaces that on a page nobody has a reason to
        // open once the heartbeat has gone quiet).
        if (wsIds.length > 0) {
          // Live-status filter here is an optimisation, not the guarantee — a
          // completed/archived mission or a passing verdict must never reach
          // buildDecideItems in the first place, but buildDecideItems re-derives
          // membership from `status`/`criteriaOverallVerdict` regardless, so this
          // query narrowing and that function's own check can never drift apart.
          const escalatedMissions = await db.query.missions.findMany({
            where: and(
              inArray(missionsTable.workspaceId, wsIds),
              isNotNull(missionsTable.criteriaEscalatedAt),
              inArray(missionsTable.status, ['active', 'paused']),
            ),
            columns: {
              id: true, title: true, status: true,
              criteriaEscalatedAt: true, criteriaRearmFingerprint: true, goalCriteriaState: true,
            },
          });
          if (escalatedMissions.length > 0) {
            const escalatedIds = escalatedMissions.map(m => m.id);
            const openNotes = await db.query.missionNotes.findMany({
              where: and(
                inArray(missionNotes.missionId, escalatedIds),
                eq(missionNotes.type, 'question'),
                eq(missionNotes.status, 'open'),
              ),
              orderBy: desc(missionNotes.createdAt),
              columns: { id: true, missionId: true, title: true, body: true },
            });
            const noteByMission = new Map<string, typeof openNotes[number]>();
            for (const n of openNotes) {
              if (n.missionId && !noteByMission.has(n.missionId)) noteByMission.set(n.missionId, n);
            }
            waitingOnYou.push(...buildDecideItems(escalatedMissions.map(m => {
              const note = noteByMission.get(m.id);
              const state = m.goalCriteriaState as import('@buildd/shared').GoalCriteriaState | null;
              return {
                missionId: m.id,
                missionTitle: m.title,
                criteriaEscalatedAt: m.criteriaEscalatedAt,
                criteriaRearmFingerprint: m.criteriaRearmFingerprint,
                openNote: note ? { id: note.id, title: note.title, body: note.body } : null,
                status: m.status,
                criteriaOverallVerdict: (state as { overall?: string } | null)?.overall ?? null,
                recommendation: describeCriteriaFailureReading(inferCriteriaFailureReading(state)),
              };
            })));
          }
        }

        // 6. Open spec discrepancy ledger rows (docs/design/spec-conformance.md
        // §7/§12) — the same table Slice 3's MCP surface (list/get/adjudicate/
        // promote_discrepancy) reads and writes. buildDiscrepancyItems is the
        // §12 re-derivation: it drops `accepted`/`resolved` rows itself rather
        // than trusting this query to have already scoped to `open`, and caps
        // + ranks per workspace so this query can stay a simple unfiltered read.
        if (wsIds.length > 0) {
          const discrepancyRows = await db.query.specDiscrepancies.findMany({
            where: inArray(specDiscrepancies.workspaceId, wsIds),
            columns: {
              id: true, workspaceId: true, specPath: true, assertionId: true,
              direction: true, status: true, firstSeenAt: true, promotedMissionId: true,
              docFixTaskId: true, lastCheckedAt: true,
              recheckRequestedAt: true, autoFollowUpTaskId: true, evidence: true,
            },
          });
          if (discrepancyRows.length > 0) {
            const discrepancyWsIds = [...new Set(discrepancyRows.map((r) => r.workspaceId))];
            const discrepancyWsRows = await db
              .select({ id: workspacesTable.id, name: workspacesTable.name })
              .from(workspacesTable)
              .where(inArray(workspacesTable.id, discrepancyWsIds));
            const wsNameById = new Map(discrepancyWsRows.map((w) => [w.id, w.name]));
            // The doc-fix claim is a stored id, so it is read against the
            // task's CURRENT status rather than trusted as "a fix is running"
            // — the queue freshness rule at the top of lib/action-queue.ts. A
            // claim held by a failed task releases the CTA again.
            const docFixTaskIds = [...new Set(
              discrepancyRows.map((r) => r.docFixTaskId).filter(Boolean) as string[],
            )];
            const docFixTasks = docFixTaskIds.length > 0
              ? await db.query.tasks.findMany({
                  where: inArray(tasks.id, docFixTaskIds),
                  columns: { id: true, status: true },
                })
              : [];
            const docFixStatusById = new Map(docFixTasks.map((t) => [t.id, t.status]));
            // A completed doc-fix task's PR state — whether it merged, and
            // when — is what tells a card apart from a genuinely-stranded one
            // (isDocFixClaimStale in lib/action-queue.ts compares this against
            // the row's own lastCheckedAt). One worker per task is assumed
            // (doc-fix tasks are single-shot planning tasks); a retried task
            // would have more than one, so the most recently started wins.
            const docFixWorkers = docFixTaskIds.length > 0
              ? await db.query.workers.findMany({
                  where: inArray(workers.taskId, docFixTaskIds),
                  columns: { taskId: true, prLifecycleStatus: true, mergedAt: true },
                  orderBy: (w, { desc: descOrder }) => [descOrder(w.startedAt)],
                })
              : [];
            const docFixWorkerByTask = new Map<string, { prLifecycleStatus: string | null; mergedAt: Date | null }>();
            for (const w of docFixWorkers) {
              if (w.taskId && !docFixWorkerByTask.has(w.taskId)) {
                docFixWorkerByTask.set(w.taskId, { prLifecycleStatus: w.prLifecycleStatus ?? null, mergedAt: w.mergedAt ?? null });
              }
            }
            const { items: discrepancyItems, overflowCount } = buildDiscrepancyItems(
              discrepancyRows.map((r) => {
                const docFixWorker = r.docFixTaskId ? docFixWorkerByTask.get(r.docFixTaskId) : undefined;
                return {
                  id: r.id,
                  workspaceId: r.workspaceId,
                  workspaceName: wsNameById.get(r.workspaceId) ?? null,
                  specPath: r.specPath,
                  assertionId: r.assertionId,
                  direction: r.direction,
                  status: r.status,
                  firstSeenAt: r.firstSeenAt,
                  lastCheckedAt: r.lastCheckedAt,
                  promotedMissionId: r.promotedMissionId,
                  docFixTaskId: r.docFixTaskId,
                  docFixTaskStatus: r.docFixTaskId ? docFixStatusById.get(r.docFixTaskId) ?? null : null,
                  docFixPrLifecycleStatus: docFixWorker?.prLifecycleStatus ?? null,
                  docFixMergedAt: docFixWorker?.mergedAt ?? null,
                  recheckRequestedAt: r.recheckRequestedAt,
                  autoFollowUpTaskId: r.autoFollowUpTaskId,
                  declaredStatus: typeof r.evidence?.declaredStatus === 'string' ? r.evidence.declaredStatus : null,
                };
              }),
            );
            waitingOnYou.push(...discrepancyItems);
            discrepancyOverflowCount = overflowCount;
          }
        }

        // This user's active gate-card snoozes (SwipeableRow's snooze-24h/3d/7d
        // on a MERGE/REVIEW card) — re-checked against `now` here, not trusted
        // as a standing flag, per the freshness invariant at the top of
        // lib/action-queue.ts.
        const activeSnoozes = user
          ? await db.query.actionQueueSnoozes.findMany({
              where: and(
                eq(actionQueueSnoozes.userId, user.id),
                gt(actionQueueSnoozes.snoozedUntil, new Date()),
              ),
              columns: { subjectKey: true },
            })
          : [];
        const snoozedSubjectKeys = new Set(activeSnoozes.map((s) => s.subjectKey));

        // Merge waitingOnYou + escalationInbox into one deduplicated action queue
        actionQueue = buildActionQueue(waitingOnYou, escalationInbox, { snoozedSubjectKeys });

        // Age telemetry. Four MERGE cards up to 90 days old were visible here
        // for months with nothing in the system counting them — the regression
        // arrived as a phone screenshot. In steady state olderThan7d is 0; a
        // non-zero value means the sweep is not converging and is the signal to
        // look at, ahead of anything the cards themselves say.
        {
          const age = summariseActionQueueAge(actionQueue);
          if (age.olderThan7dCount > 0 || age.p99AgeHours > 0) {
            console.log(
              `[home] action_queue.card_age_hours p99=${age.p99AgeHours} older_than_7d=${age.olderThan7dCount} `
              + `stale_unverified=${age.staleUnverified} stale_ancient=${age.staleAncient} measured=${age.measured}`,
            );
          }
        }

        // Discrepancy overflow telemetry — the DISCREPANCY-queue equivalent of
        // the age metric above (§12): a clean-looking top-10 must never hide a
        // growing backlog the way the Schedules page did.
        if (discrepancyOverflowCount > 0) {
          console.log(`[home] discrepancy_queue.overflow_count=${discrepancyOverflowCount}`);
        }

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
            // Team-level roles (workspaceId NULL, teamId set) are the default
            // shape; workspace-scoped ones override per workspace.
            activeTeamId
              ? or(inArray(workspaceSkills.workspaceId, wsIds), and(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.teamId, activeTeamId)))
              : inArray(workspaceSkills.workspaceId, wsIds),
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

        // Roles load after the missions block: colour the rows' live dots now.
        for (const r of homeMissionRows) {
          for (const d of r.model.live.dots) if (d.roleSlug && !d.color) d.color = rolesMap.get(d.roleSlug)?.color ?? null;
        }

        // Fleet panel, ticker and stat counts — one loader, all batched.
        {
          const [teamRow] = activeTeamId
            ? await db.select({ name: teamsTable.name, timezone: teamsTable.timezone }).from(teamsTable).where(eq(teamsTable.id, activeTeamId)).limit(1)
            : [];
          teamName = teamRow?.name ?? null;
          teamTz = teamRow?.timezone ?? null;
          fleetData = await loadHomeFleet({
            teamId: activeTeamId ?? null,
            wsIds,
            now: renderNow,
            dayStart: startOfDayInZone(renderNow, teamTz),
            roles: new Map([...rolesMap].map(([slug, r]) => [slug, { name: r.name, color: r.color ?? null }])),
          }).catch(err => {
            console.error('[home] fleet load failed (non-fatal):', err);
            return null;
          });
          // Running cells in the missions rows fill to their worker's progress.
          const progressByTask = new Map<string, number>();
          for (const r of fleetData?.fleet.runners ?? []) for (const sl of r.slots) {
            if (sl.worker?.taskId && sl.worker.progress != null) progressByTask.set(sl.worker.taskId, sl.worker.progress);
          }
          for (const row of homeMissionRows) for (const p of row.model.phases) for (const c of p.cells) {
            if (c.state === 'running' && progressByTask.has(c.taskId)) c.fill = progressByTask.get(c.taskId)! / 100;
          }
        }

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

  // Chips SCOPE the Waiting-on-you queue (never group it). The section still
  // gates on the unfiltered queue so a filter that empties it doesn't hide the
  // chips (leaving the user unable to clear the filter).
  const filteredActionQueue = initFilter
    ? actionQueue.filter((i) => i.initiativeId === initFilter)
    : actionQueue;
  // Human work first, then what an agent is already finishing — rendered as
  // two groups so the count in the header matches the cards under it.
  // RESOLVING / FIXING_CI / CI_RUNNING / FIXING_SPEC are informational: they
  // stay visible but never count as needing the human.
  const { needsYou: needsYouItems, inFlight: inFlightItems } = splitWaitingOnYou(filteredActionQueue);
  const rightNow = rightNowState({
    inFlightCount: activeItems.length + agentReviewingPrs.length + reviewQueuedPrs.length,
    workspaceCount,
    totalTaskCount,
  });

  // ── Fleet redesign ──
  const questions: HomeQuestion[] = (fleetData?.questions ?? []).map(q => ({
    workerId: q.workerId, taskId: q.taskId, label: q.label, runnerName: q.runnerName,
    askedAt: q.askedAt, prompt: q.prompt, options: q.options,
    href: q.taskId ? homeTaskHref({ missionId: q.missionId, taskId: q.taskId, from: 'home', mode: 'sheet' }) : null,
  }));
  // A parked worker's question renders once, as the one-tap card.
  const answeredInline = new Set(questions.map(q => q.taskId).filter(Boolean));
  const queueNeedsYou = needsYouItems.filter(i => !(i.chip === 'QUESTION' && i.taskId && answeredInline.has(i.taskId)));
  const needsYouCount = questions.length + heldMissions.length + queueNeedsYou.length;
  const needsYouDetail = [
    questions.length > 0 && `${questions.length} question${questions.length === 1 ? '' : 's'}`,
    heldMissions.length > 0 && `${heldMissions.length} held`,
    queueNeedsYou.length > 0 && `${queueNeedsYou.length} to act on`,
  ].filter(Boolean).join(' · ') || null;
  const live = fleetData?.fleet.live ?? activeItems.length;
  const headline = homeHeadline({ live, needsYou: needsYouCount, shipped: shippedMissions[0]?.title ?? null });
  const clock = new Date(renderNow).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    ...(teamTz ? { timeZone: teamTz } : {}),
  });
  const stats = fleetData?.stats;
  // Legend: the roles on today's lanes (every role when the lanes are empty).
  const lanesRoles = new Set((fleetData?.fleet.runners ?? []).flatMap(r => r.slots.flatMap(sl => sl.lane.bars.map(b => b.roleSlug))).filter(Boolean));
  const fleetRoles = teamRoles
    .filter(r => lanesRoles.size === 0 || lanesRoles.has(r.slug))
    .map(r => ({ slug: r.slug, name: r.name, color: r.color ?? null }));

  return (
    <SwipeProvider>
    <main className="min-h-screen pt-14 px-4 pb-20 md:pt-8 md:px-8 md:pb-8">
      <HomeAutoRefresh workspaceIds={refreshWorkspaceIds} />
      <div className="mx-auto max-w-[1320px]">
        <header className="mb-5 flex flex-col gap-3 md:mb-6 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <div className="section-label hidden text-text-muted md:block">Home{teamName ? ` · ${teamName}` : ''}</div>
            <h1 data-testid="home-headline" className="mt-1.5 font-mono text-[22px] font-semibold leading-tight tracking-[-0.5px] text-text-primary md:text-[28px]">
              {headline.map((part, i) => (
                <span key={i} className={part.tone === 'accent' ? 'text-accent-text' : part.tone === 'success' ? 'text-status-success' : undefined}>
                  {part.text}
                </span>
              ))}
            </h1>
            {arcHeadline && <p className="mt-1 font-mono text-[13px] text-text-secondary">{arcHeadline}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="hidden min-h-9 items-center gap-2 border border-border-default px-3 font-mono text-[12.5px] text-text-secondary md:flex">
              <i aria-hidden="true" className="inline-block h-2 w-2 bg-accent" />
              {clock}
            </span>
            {teamWorkspaces.length > 0 && (
              <span className="hidden md:block">
                <WorkspaceFilter workspaces={teamWorkspaces} selectedId={wsFilter ?? null} />
              </span>
            )}
            <Link
              href="/app/missions/new"
              className="hidden min-h-9 items-center border-2 border-primary bg-primary px-3.5 font-mono text-[12.5px] font-semibold text-white shadow-sm hover:bg-primary-hover md:inline-flex"
            >
              + Mission
            </Link>
          </div>
        </header>

        {/* Initiative pulse — at most one line, and nothing at all when
            every arc is winning/dormant/empty (§2.1, §2.2, AC-1). */}
        <InitiativePulseLine items={pulseItems} />

        {rightNow !== 'create-workspace' && rightNow !== 'get-started' && (
          <StatStrip
            live={live}
            capacity={fleetData?.fleet.capacity ?? 0}
            runners={fleetData?.fleet.runners.filter(r => r.online).length ?? 0}
            needsYou={needsYouCount}
            needsYouDetail={needsYouDetail}
            mergedToday={stats?.mergedToday ?? 0}
            mergedDetail={stats && stats.mergedPrNumbers.length > 0 ? stats.mergedPrNumbers.slice(0, 4).map(n => `#${n}`).join(' ') : null}
            prsInCi={stats?.prsInCi ?? []}
            selfHealed={stats?.selfHealed ?? 0}
          />
        )}

        {/* Below xl the asks come first: on a phone the first screen is what needs you. */}
        <div className="flex flex-col xl:grid xl:grid-cols-[minmax(0,1fr)_400px] xl:gap-8">
          <div className="min-w-0">
            <div data-testid="home-right-now">
              {rightNow === 'create-workspace' || rightNow === 'get-started' ? (
                <div className="mb-8">
                  <div className="section-label mb-4">Right Now</div>
                  {rightNow === 'create-workspace' ? (
                <div className="border border-dashed border-border-default rounded-[10px] p-5">
                  <div className="text-[13px] font-medium text-text-primary mb-2">Create a workspace</div>
                  <p className="text-[13px] text-text-secondary mb-4">
                    This team has no workspace. Connect a GitHub repo to run agents.
                  </p>
                  <Link
                    href="/app/workspaces/new"
                    className="inline-flex items-center gap-1.5 rounded-[6px] bg-primary px-3 py-2 text-[13px] font-medium text-white hover:opacity-90 transition-opacity"
                  >
                    Connect a repo
                  </Link>
                </div>
              ) : rightNow === 'get-started' ? (
                <div className="border border-dashed border-border-default rounded-[10px] p-5">
                  <div className="text-[13px] font-medium text-text-primary mb-3">Get started</div>
                  <div className="space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="w-5 h-5 rounded-full border border-border-default flex items-center justify-center flex-shrink-0 mt-0.5">
                        <span className="text-[11px] font-mono text-text-muted">1</span>
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
                        <span className="text-[11px] font-mono text-text-muted">2</span>
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
                        <span className="text-[11px] font-mono text-text-muted">3</span>
                      </div>
                      <div className="min-w-0">
                        <div className="text-[13px] text-text-primary">
                          <Link href="/app/tasks/new" className="text-accent-text hover:underline">Create a task</Link>
                          {' '}or start the runner
                        </div>
                        <div className="mt-1.5 px-3 py-2 bg-surface-3 rounded-[6px] font-mono text-[11px] text-text-secondary overflow-x-auto">
                          buildd
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                  ) : null}
                </div>
              ) : (
                <>
                  {fleetData && <FleetStrip fleet={fleetData.fleet} roles={fleetRoles} now={renderNow} timeZone={teamTz} />}
                  {(agentReviewingPrs.length > 0 || reviewQueuedPrs.length > 0) && (
                    <div className="mb-8 space-y-2">
            {/* Agent-reviewing PR cards — ambient presence, not actionable */}
            {agentReviewingPrs.map((item) => (
              <div
                key={item.reviewerWorkerId}
                className="border border-border-default rounded-[10px] px-4 py-3 bg-surface-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="text-[11px] font-mono font-medium text-text-muted tracking-wide uppercase">
                        Agent Reviewing
                      </span>
                      {item.reviewerRoleSlug && (
                        <span className="text-[11px] text-text-muted">· {item.reviewerRoleSlug}</span>
                      )}
                      {item.reviewerStartedAt && (
                        <span className="text-[11px] text-text-muted">
                          {timeAgo(item.reviewerStartedAt)}
                        </span>
                      )}
                      {!!item.unblockCount && item.unblockCount > 0 && (
                        <span className="text-[11px] text-text-muted">
                          · unblocks {item.unblockCount} task{item.unblockCount === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                    <Link
                      href={actionCardTaskLink(item)}
                      className="text-[13px] font-medium text-text-primary line-clamp-2 [overflow-wrap:anywhere] hover:underline"
                    >
                      {item.taskTitle}
                    </Link>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {item.workspaceName && (
                        <span className="text-[11px] text-text-muted">{item.workspaceName}</span>
                      )}
                      {item.prUrl && (
                        <ExternalLink href={item.prUrl} className="inline-flex items-center min-h-11 md:min-h-0 text-[11px] text-text-muted hover:underline">
                          PR #{item.prNumber} ↗
                        </ExternalLink>
                      )}
                    </div>
                  </div>
                  <InterruptReviewButton workerId={item.reviewerWorkerId} />
                </div>
              </div>
            ))}
            {/* Review-queued PR cards have no live reviewer worker.
                The agent still owns these during the dispatch grace period. */}
            {reviewQueuedPrs.map((item) => (
              <div
                key={item.taskId}
                className="border border-border-default rounded-[10px] px-4 py-3 bg-surface-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-[11px] font-mono font-medium text-text-muted tracking-wide uppercase">
                      Review Queued
                    </span>
                    {!!item.unblockCount && item.unblockCount > 0 && (
                      <span className="text-[11px] text-text-muted">
                        · unblocks {item.unblockCount} task{item.unblockCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  <Link
                    href={actionCardTaskLink(item)}
                    className="text-[13px] font-medium text-text-primary line-clamp-2 [overflow-wrap:anywhere] hover:underline"
                  >
                    {item.taskTitle}
                  </Link>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {item.workspaceName && (
                      <span className="text-[11px] text-text-muted">{item.workspaceName}</span>
                    )}
                    {item.prUrl && (
                      <ExternalLink href={item.prUrl} className="inline-flex items-center min-h-11 md:min-h-0 text-[11px] text-text-muted hover:underline">
                        PR #{item.prNumber} ↗
                      </ExternalLink>
                    )}
                    {item.reason && (
                      <span className="text-[11px] text-text-muted">{item.reason}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <HomeMissionsSummary rows={homeMissionRows} total={missionTotal} shippedToday={shippedToday} />

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

            {/* Release Queue — gated workspaces with unshipped commits and CI green (spec §8) */}
            <ReleaseWidget items={releaseReadinessItems} />
          </div>

          <div className="order-first min-w-0 xl:order-none">
            <NeedsYouStack
              count={needsYouCount}
              questions={questions}
              held={heldMissions}
              shipped={shippedMissions}
              timeZone={teamTz}
            >
              {actionQueue.length > 0 && (
                <div data-testid="home-action-queue">
                  {/* Initiative scoping chips — SCOPE the queue, never group it. */}
                  <InitiativeFilterChips
                    initiatives={actionQueueInitiatives}
                    selectedId={initFilter ?? null}
                    workspaceFilter={wsFilter ?? null}
                  />
                  {filteredActionQueue.length === 0 && (
                    <p className="text-[13px] text-text-muted mb-2">Nothing waiting for this initiative.</p>
                  )}
                  {queueNeedsYou.length > 0 && (
                    <div data-testid="waiting-needs-you" className="space-y-2">
                      {queueNeedsYou.map((item) => <ActionQueueCard key={item.subjectKey} item={item} />)}
                    </div>
                  )}
                  {inFlightItems.length > 0 && (
                    <div data-testid="waiting-in-flight" className={queueNeedsYou.length > 0 ? 'mt-5' : undefined}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="section-label-missions text-[11px] text-text-muted">In flight</span>
                        <span className="text-[11px] text-text-muted font-mono">{inFlightItems.length}</span>
                      </div>
                      <div className="space-y-2">
                        {inFlightItems.map((item) => <ActionQueueCard key={item.subjectKey} item={item} />)}
                      </div>
                    </div>
                  )}
                  {/* §12: overflow past the top-10-per-workspace cap is never
                      silently dropped — a clean-looking queue must not be able
                      to hide a growing backlog the way the Schedules page did. */}
                  {discrepancyOverflowCount > 0 && (
                    <p className="text-[11px] text-text-muted mt-2">
                      +{discrepancyOverflowCount} more spec{discrepancyOverflowCount === 1 ? '' : 's'} with open discrepancies beyond the visible top 10
                    </p>
                  )}
                </div>
              )}
              {resolvedEscalations.length > 0 && <ResolvedEscalationsGroup items={resolvedEscalations} />}
            </NeedsYouStack>

            <ActivityTicker events={fleetData?.ticker ?? []} timeZone={teamTz} />
          </div>
        </div>
      </div>
    </main>
    </SwipeProvider>
  );
}
