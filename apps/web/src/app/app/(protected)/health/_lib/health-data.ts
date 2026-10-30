import 'server-only';
import { db } from '@buildd/core/db';
import { workspaces, tasks, workers, workspaceSkills, taskSchedules, missions, secrets, workerErrorTraces, teamMembers } from '@buildd/core/db/schema';
import { and, count, eq, inArray, desc, sql, or, isNull } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import { getRunnerHeartbeats, type RunnerHeartbeat } from '@/lib/runner-heartbeats';
import { isRunnerOnline, isRunnerRecentlySeen } from '@/lib/runner-heartbeats-shared';
import {
  isolationBlockedCounts,
  isolationStrandedCount,
  pendingIsolationTask,
  type PendingIsolationTask,
} from '@/lib/runner-isolation-health';
import { getBudgetForecast, type BudgetForecast } from '@/lib/budget-forecast';
import {
  computeUsageStats,
  describeScan,
  isUnassignedWork,
  parseWindowMs,
  UNASSIGNED_ROLE,
  INFERRED_ROLE_SUFFIX,
  type GroupEntry,
  type ScanBounds,
  type UsageStats as UsageRollup,
} from '@/lib/usage-stats';
import { fetchUsageRows, USAGE_ROW_LIMIT } from '@/lib/usage-stats-query';
import {
  getFailureAnalytics,
  getFailureTotals,
  parseFailureWindow,
  type FailureHeadline,
  type FailureAnalytics,
  type FailureWindow,
} from '@/lib/failure-analytics';
import { getGateAnalytics } from '@/lib/gate-analytics-query';
import { getBackendStrandSummary, type SampleTaskRoute } from '@/lib/backend-strand';
import { withoutRunnerServedStrands } from '@/lib/strand-headline';
import type { ClaimBlocker } from '@/lib/claim-blocker-projection';
import { buildSubagentDelegationPanel, type SubagentMetrics } from '@/lib/subagent-time';
import type { DerivedMetric } from '@buildd/core/derived-metric';
import { fetchSubagentTimeRows, SUBAGENT_TIME_CAPTURED_SINCE, SUBAGENT_TIME_ROW_LIMIT } from '@/lib/subagent-time-query';
import { buildErrorPatternPanel, type ErrorPatternMetrics } from '@/lib/error-pattern-cost';
import {
  fetchErrorPatternRows,
  errorPatternEffectiveStart,
  ERROR_TRACE_GATED_SINCE,
  ERROR_PATTERN_ROW_LIMIT,
} from '@/lib/error-pattern-cost-query';
import { countWorkersInWindow, fetchActionEvents } from '@/lib/action-events';
import { loadHealthExperiments } from '@/lib/health-experiments';
import { getDispatchHealth } from '@/lib/dispatch-health';
import { loadClaimPlanHealth } from '@/lib/claim-plan-health-query';
import type { ClaimPlanHealth } from '@/lib/claim-plan-health';
import { loadAgentAccessReport, type AgentAccessReport } from '@/lib/agent-capabilities/access-log';
import { buildFailureGroups, type FailureGroupsView } from '@/lib/health-failure-groups';
import { FAILED_WORKER_STATUSES, type FleetSnapshot } from '@buildd/shared';
import { loadRunnersFleet } from '@/lib/home-fleet';
import type { LaneMission } from '@/components/fleet/runner-lanes';
import { loadLaneMissions } from './lane-missions';
import type { IdleStretch } from '@/lib/idle-while-queued';
import { CLAUDE_CREDENTIAL_PURPOSES, isBackendHealthRow } from '@/lib/claude-credential-rows';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { readRound } from '@/lib/read-round';

export type { BudgetForecast, FailureAnalytics, FailureHeadline, FailureWindow };
export type { GateAnalytics } from '@buildd/shared';
export type { SubagentMetrics };
export type SubagentDelegationPanel = DerivedMetric<SubagentMetrics>;
export type { ErrorPatternMetrics };
export type ErrorPatternPanel = DerivedMetric<ErrorPatternMetrics>;


export interface ScheduleRow {
  id: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  /** LIFETIME streak — renders `{N} in a row`, never a window. */
  consecutiveFailures: number;
  /** LIFETIME counter — renders `{N} runs since created`, never a window. */
  totalRuns: number;
  /** The anchor `totalRuns` counts from. */
  createdAt: string | null;
  taskTitle: string;
  missionTitle: string | null;
  /** The mission that owns this schedule, where it is configured; null for a workspace schedule. */
  missionId?: string | null;
  isHeartbeat: boolean;
}

/**
 * Task-keyed totals over the page window.
 *
 * Deliberately NOT a per-role rollup: `/app/team` already renders an identical
 * per-role done/failed breakdown, so Health links there instead of publishing a
 * second copy. What survives here is only what `/app/team` cannot serve — it
 * filters `roleSlug IS NOT NULL`, so role-less tasks are invisible there, and it
 * is team-wide, so it cannot honour Health's `?workspace=` scoping.
 */
/**
 * A worker row whose PR the reconcile sweep could not resolve and has retired
 * to terminal `prLifecycleStatus = 'unresolvable'`.
 *
 * These are deliberately absent from Home: an action queue is for things a
 * human can act on, and a PR buildd cannot resolve is not one of them. Listing
 * them here is how they stay visible without being an actionable card.
 */
export interface OrphanedPrRow {
  workerId: string;
  workspaceName: string;
  taskId: string | null;
  taskTitle: string | null;
  prUrl: string | null;
  prNumber: number | null;
  reason: string | null;
  failureCount: number;
  lastCheckedAt: string | null;
  prOpenedAt: string | null;
}

export interface UsageStats {
  total: number;
  completed: number;
  failed: number;
  unassigned: number;
}

/**
 * Consumption rollup for the health page: what work costs, as opposed to
 * `UsageStats` above, which counts whether it landed. Role groups carry the
 * same name/color as the role block so the two read as one story.
 */
export interface ConsumptionGroup extends GroupEntry {
  label: string;
  color: string;
}

export interface ConsumptionStats extends Omit<UsageRollup, 'groups'> {
  window: string;
  groups: ConsumptionGroup[];
  /**
   * What the numbers were actually computed over. The page reads worker rows
   * directly and the read is capped, so on a busy team every figure below is a
   * floor over a narrower window than the label claims — which the section says
   * out loud rather than leaving the reader to assume full coverage.
   */
  scan: ScanBounds;
  /** buildd tool calls per action over the same window, for the tool list's buildd row. Null when unavailable. */
  builddActions: { totalCalls: number; actions: Array<{ action: string; calls: number }> } | null;
}

export interface RecentFailure {
  workerId: string;
  taskId: string | null;
  taskTitle: string;
  workspaceName: string;
  error: string | null;
  completedAt: string;
}

/**
 * A backend that is stranding pending work: its effective backend has no
 * credential, so no runner can claim those tasks. Shaped here (rather than
 * re-exporting the lib type) so the client component imports nothing that
 * touches the DB.
 */
export interface StrandedBackendRow {
  backend: string;
  label: string;
  strandedPending: number;
  enabledForTeam: boolean;
  sampleTasks: Array<{ id: string; title: string; workspaceName: string | null; claim?: ClaimBlocker; route?: SampleTaskRoute }>;
}

export interface CredentialHealthItem {
  id: string;
  purpose: string;
  /**
   * Every backend credential is returned, not only the broken ones: Problems
   * lists the `degraded`/`revoked` rows, and State renders credential health as
   * a STATE with its own freshness — which needs the healthy rows too.
   */
  healthStatus: 'healthy' | 'degraded' | 'revoked' | 'unknown';
  consecutiveAuthFailures: number;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  lastSuccessAt: string | null;
  lastVerifiedAt: string | null;
}

/**
 * Which data each Health page needs. A page asks only for its own sources, so
 * Overview does not pay for the gate ledger and Failures does not run the
 * subagent-time query. The sources and their shapes are unchanged from the
 * single Health page they came from.
 */
export type HealthDataKey =
  | 'runners' | 'usageStats' | 'schedules' | 'recentFailures' | 'credentials'
  | 'budgetForecast' | 'consumption' | 'failureAnalytics' | 'gateAnalytics'
  | 'strandedBackends' | 'subagentDelegation' | 'errorPatterns'
  | 'runnerLanes' | 'claimPlans' | 'dispatchHealth' | 'orphanedPrs' | 'experiments' | 'failureGroups' | 'agentAccess'
  | 'failureHeadline';

export type HealthPageKey = 'overview' | 'failures' | 'runners' | 'operator';

export const HEALTH_PAGE_DATA: Record<HealthPageKey, ReadonlySet<HealthDataKey>> = {
  // Problems: broken credentials, stranded backends, offline runners, failing schedules.
  // failureGroups feeds the Overview's top failures (failureProblemLine) and the
  // status sentence's failure count; budgetForecast feeds the Budget row.
  // agentAccess: access problems count on Overview and are listed on Failures.
  overview: new Set(['runners', 'schedules', 'credentials', 'strandedBackends', 'failureGroups', 'budgetForecast', 'agentAccess']),
  // failureAnalytics stays for the headline rate (failed / finished).
  failures: new Set(['failureHeadline', 'failureGroups', 'agentAccess']),
  runners: new Set(['runners', 'runnerLanes', 'claimPlans', 'budgetForecast', 'credentials']),
  operator: new Set([
    'dispatchHealth', 'gateAnalytics', 'experiments', 'subagentDelegation',
    'usageStats', 'orphanedPrs', 'errorPatterns', 'consumption', 'failureAnalytics',
  ]),
};

/** Failed workers read for the grouped view. Newest first; older ones drop past the cap. */
export const FAILURE_GROUP_WORKER_LIMIT = 500;
/** Characters of each failed worker's error read for grouping and the sample shown. */
export const FAILURE_ERROR_CHARS = 1000;
/** Failing schedules listed; more than this many is one problem, not a list. */
const SCHEDULE_PROBLEM_LIMIT = 50;

export interface HealthData {
  orphanedPrs: OrphanedPrRow[];
  runners: RunnerHeartbeat[];
  usageStats: UsageStats | null;
  consumption: ConsumptionStats | null;
  schedules: ScheduleRow[];
  recentFailures: RecentFailure[];
  credentialHealth: CredentialHealthItem[];
  strandedBackends: StrandedBackendRow[];
  wsFilter: string | null;
  budgetForecast: BudgetForecast | null;
  failureAnalytics: FailureAnalytics | null;
  /** Failures' headline: the rate over finished workers in the window, counted in SQL. */
  failureHeadline: FailureHeadline | null;
  gateAnalytics: import('@buildd/shared').GateAnalytics | null;
  window: FailureWindow;
  subagentDelegation: SubagentDelegationPanel | null;
  errorPatterns: ErrorPatternPanel | null;
  experiments: Awaited<ReturnType<typeof loadHealthExperiments>> | null;
  dispatchHealth: Awaited<ReturnType<typeof getDispatchHealth>> | null;
  /** What is failing, one group per cause (lib/health-failure-groups.ts). */
  failureGroups: (FailureGroupsView & { truncated: boolean }) | null;
  /** Grants and refusals for agent runs in the scoped workspaces (lib/agent-capabilities/access-log.ts). */
  agentAccess: AgentAccessReport | null;
  /** A task waits in the scoped workspaces; a runner with no current sandbox check refuses it. */
  protectedWorkPending: boolean;
  /** Pending tasks every online runner refuses for isolation (isolationStrandedCount). */
  isolationStranded: number;
  /** Runners page: the fleet with lane history and its idle-while-queued stretches. */
  runnerLanes: { fleet: FleetSnapshot; idle: IdleStretch[]; missions: Record<string, LaneMission> } | null;
  /** Whether the viewer may read teammates' work in expanded runner detail (view_team_usage); a member sees only their own. */
  seesTeamWork: boolean;
  /** Claim-planner ledger summary (claimability), apart from slot occupancy; null hides the section. */
  claimPlans: ClaimPlanHealth | null;
  /** The workspaces `runnerLanes` reads, so the page can re-render on their worker events. */
  laneWorkspaceIds: string[];
  /** The active team's workspaces whose new starts are paused now (raw names), for the Runners page's banners. */
  pausedWorkspaces: Array<{ id: string; name: string; pausedUntil: string }>;
  now: number;
}

export type HealthLoad = { kind: 'no-workspaces' } | { kind: 'ok'; data: HealthData };

/**
 * Load one Health page's data for the signed-in user (the caller has already
 * checked there is a user and a team).
 */
export async function loadHealth({
  page, userId, teamIds, searchParams, operator = false,
}: {
  page: HealthPageKey;
  userId: string;
  /** The viewer is a buildd platform operator: experiments are theirs to manage. */
  operator?: boolean;
  teamIds: string[];
  searchParams: { workspace?: string; window?: string; failureWindow?: string };
}): Promise<HealthLoad> {
  const need = (key: HealthDataKey) => HEALTH_PAGE_DATA[page].has(key);
  const { workspace: wsFilter, window: rawWindow, failureWindow: rawFailureWindow } = searchParams;
  const window = parseFailureWindow(rawWindow ?? rawFailureWindow);
  // ONE clock read for the whole page, pinned server-side and passed down as
  // data. HealthClient no longer calls `Date.now()` in its render body: a
  // client component's render runs twice (once on the server for the HTML,
  // once on the client during hydration), and a `Date.now()` read at render
  // time can land on either side of a runner's online/offline threshold or a
  // schedule's due time between those two passes, producing a hydration
  // mismatch. Threading one server-pinned value through as a prop makes both
  // passes render from the exact same input.
  const now = Date.now();
  const cookieStore = await cookies();
  const activeTeamId =
    (await resolveActiveTeamId(userId, cookieStore.get('buildd-team')?.value)) ?? teamIds[0];

  // Workspaces for the active team
  const teamWorkspaceRows = await db
    .select({ id: workspaces.id, name: workspaces.name, teamId: workspaces.teamId, pausedUntil: workspaces.newStartsPausedUntil })
    .from(workspaces)
    .where(eq(workspaces.teamId, activeTeamId));

  const teamWorkspaceIds = (teamWorkspaceRows as any[]).map((w: any) => w.id as string);
  if (teamWorkspaceIds.length === 0) return { kind: 'no-workspaces' };

  const scopedWsIds = wsFilter && teamWorkspaceIds.includes(wsFilter)
    ? [wsFilter]
    : teamWorkspaceIds;

  const wsById = new Map((teamWorkspaceRows as any[]).map((w: any) => [w.id as string, w.name as string] as const));

  // Team-wide spend (the budget forecast) is for people holding
  // view_team_usage in the active team; a member's Health never loads it.
  const seesTeamSpend = need('budgetForecast')
    && await can({ kind: 'user', userId }, 'view_team_usage', activeTeamId).catch(() => false);

  // Parallel fetches: runners, usage, schedules, recent failures, credential
  // health, budget forecast, consumption, aggregated failure analytics, and
  // backends stranding pending work
  const [
    heartbeats,
    usageStats,
    scheduleRows,
    recentFailureRows,
    credentialHealthRows,
    budgetForecast,
    consumption,
    failureAnalytics,
    failureHeadline,
    gateAnalytics,
    strandSummary,
    subagentDelegation,
    errorPatterns,
    dispatchHealth,
    failureGroups,
    agentAccess,
    pendingIsolation,
  ] = await Promise.all([
    // Runner heartbeats relevant to the scoped workspaces
    need('runners')
      ? getRunnerHeartbeats(activeTeamId, scopedWsIds, userId).catch(() => [] as RunnerHeartbeat[])
      : [] as RunnerHeartbeat[],

    // Task-keyed totals over the page window (was a fixed 30d role rollup).
    // Exclude attempt tasks (parentTaskId IS NOT NULL) so CI retries don't inflate counts.
    need('usageStats')
      ? (async (): Promise<UsageStats | null> => {
      const windowStart = new Date(Date.now() - parseWindowMs(window));
      const recentTasks = await db.query.tasks.findMany({
        where: sqlWhere(and(
          inArray(tasks.workspaceId, scopedWsIds),
          sql`${tasks.createdAt} >= ${windowStart}`,
          isNull(tasks.parentTaskId),
        )),
        columns: { roleSlug: true, status: true, taskClass: true },
      });

      if (recentTasks.length === 0) return null;

      let completed = 0;
      let failed = 0;
      let unassigned = 0;
      for (const t of recentTasks) {
        if (t.status === 'completed') completed++;
        if (t.status === 'failed') failed++;
        if (isUnassignedWork(t)) unassigned++;
      }

      return { total: recentTasks.length, completed, failed, unassigned };
    })().catch(() => null)
      : null,

    // Failing schedules across the scoped workspaces, with mission linkage.
    // Health shows a schedule only while its error is live (enabled, with a
    // last error: isScheduleErrorLive), so the query reads only those, and of
    // the task template only its title and heartbeat flag, never its body.
    need('schedules')
      ? db
          .select({
            id: taskSchedules.id,
            workspaceId: taskSchedules.workspaceId,
            name: taskSchedules.name,
            cronExpression: taskSchedules.cronExpression,
            timezone: taskSchedules.timezone,
            enabled: taskSchedules.enabled,
            nextRunAt: taskSchedules.nextRunAt,
            lastRunAt: taskSchedules.lastRunAt,
            lastError: taskSchedules.lastError,
            consecutiveFailures: taskSchedules.consecutiveFailures,
            totalRuns: taskSchedules.totalRuns,
            createdAt: taskSchedules.createdAt,
            taskTemplate: sql<{ title?: string } | null>`jsonb_build_object('title', ${taskSchedules.taskTemplate}->>'title')`,
            heartbeat: sql<unknown>`${taskSchedules.taskTemplate}->'context'->'heartbeat'`,
            missionTitle: missions.title,
            missionId: missions.id,
          })
          .from(taskSchedules)
          .leftJoin(missions, eq(missions.scheduleId, taskSchedules.id))
          .where(and(
            inArray(taskSchedules.workspaceId, scopedWsIds),
            eq(taskSchedules.enabled, true),
            sql`${taskSchedules.lastError} is not null and ${taskSchedules.lastError} <> ''`,
          ))
          .limit(SCHEDULE_PROBLEM_LIMIT)
          .catch(() => [] as any[])
      : [] as any[],

    // Recent worker failures across scoped workspaces (past 24h)
    need('recentFailures')
      ? (async (): Promise<RecentFailure[]> => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const failedWorkers = await db.query.workers.findMany({
        where: sqlWhere(and(
          inArray(workers.workspaceId, scopedWsIds),
          eq(workers.status, 'failed'),
          sql`${workers.completedAt} >= ${cutoff}`,
        )),
        columns: { id: true, taskId: true, workspaceId: true, error: true, completedAt: true },
        orderBy: sqlOrderBy([desc(workers.completedAt)]),
        limit: 20,
      });
      if (failedWorkers.length === 0) return [];

      const taskIds = (failedWorkers as any[]).flatMap((w: any) => w.taskId ? [w.taskId as string] : []);
      const taskTitles = taskIds.length
        ? await db.query.tasks.findMany({
            where: sqlWhere(inArray(tasks.id, taskIds)),
            columns: { id: true, title: true },
          })
        : [];
      const titleById = new Map((taskTitles as any[]).map((t: any) => [t.id as string, t.title as string]));

      return (failedWorkers as any[]).map((w: any) => ({
        workerId: w.id,
        taskId: w.taskId ?? null,
        taskTitle: (w.taskId && titleById.get(w.taskId)) ? titleById.get(w.taskId)! : 'Untitled task',
        workspaceName: wsById.get(w.workspaceId) ?? '(unknown)',
        error: w.error ?? null,
        completedAt: w.completedAt ? w.completedAt.toISOString() : new Date().toISOString(),
      }));
    })().catch(() => [] as RecentFailure[])
      : [] as RecentFailure[],

    // Backend credentials for this team — ALL of them, not just the broken
    // ones. Problems renders the degraded/revoked rows; State renders credential
    // health as a STATE with its own freshness, which needs the healthy rows.
    need('credentials')
      ? (async (): Promise<CredentialHealthItem[]> => {
      // Claude credentials in every storage agent runs read (the Anthropic
      // key's canonical `inference_key` row too), plus Codex. `inference_key`
      // also holds other providers' and personal keys: isBackendHealthRow drops them.
      const credRows = (await db.query.secrets.findMany({
        where: sqlWhere(and(
          eq(secrets.teamId, activeTeamId),
          or(
            ...CLAUDE_CREDENTIAL_PURPOSES.map((p) => eq(secrets.purpose, p)),
            eq(secrets.purpose, 'codex_credential'),
          ),
        )),
        columns: {
          id: true,
          purpose: true,
          label: true,
          userId: true,
          healthStatus: true,
          consecutiveAuthFailures: true,
          lastFailureAt: true,
          lastFailureMessage: true,
          lastSuccessAt: true,
          lastVerifiedAt: true,
        },
      })).filter(isBackendHealthRow);
      return (credRows as any[]).map((r: any) => ({
        id: r.id,
        purpose: r.purpose,
        healthStatus: r.healthStatus as CredentialHealthItem['healthStatus'],
        consecutiveAuthFailures: r.consecutiveAuthFailures,
        lastFailureAt: r.lastFailureAt ? r.lastFailureAt.toISOString() : null,
        lastFailureMessage: r.lastFailureMessage ?? null,
        lastSuccessAt: r.lastSuccessAt ? r.lastSuccessAt.toISOString() : null,
        lastVerifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
      }));
    })().catch(() => [] as CredentialHealthItem[])
      : [] as CredentialHealthItem[],

    // Budget forecast
    // Overview shows the month's spend and whether a provider is paused; the
    // full forecast (seats, mission budgets) is the Runners page's.
    seesTeamSpend ? getBudgetForecast(activeTeamId, scopedWsIds, { summaryOnly: page === 'overview' }).catch(() => null as BudgetForecast | null) : null,
    // Consumption: tokens / cost / turns / tool calls per task, by role. TREND —
    // obeys the page window (it used to be pinned to 7d while the section above
    // it was pinned to 30d, so the page published two windows and named neither).
    need('consumption')
      ? (async (): Promise<ConsumptionStats | null> => {
      const windowStart = new Date(Date.now() - parseWindowMs(window));
      const [rows, actionRows] = await Promise.all([
        fetchUsageRows({ workspaceIds: scopedWsIds, windowStart }),
        // A failure here costs the buildd row its breakdown, not the section.
        fetchActionEvents({ workspaceIds: scopedWsIds, windowStart }).catch(() => null),
      ]);
      if (rows.length === 0) return null;
      const builddActions = actionRows ? countActions(actionRows) : null;

      const stats = computeUsageStats(rows, 'role');
      const scan = describeScan(rows, windowStart, USAGE_ROW_LIMIT);
      const slugs = [...new Set(stats.groups.map(g => g.roleSlug).filter((k): k is string => !!k))];
      const roleRows = slugs.length > 0
        ? await db.query.workspaceSkills.findMany({
            where: sqlWhere(and(
              inArray(workspaceSkills.workspaceId, scopedWsIds),
              eq(workspaceSkills.isRole, true),
              inArray(workspaceSkills.slug, slugs),
            )),
            columns: { slug: true, name: true, color: true },
          })
        : [];
      const roleBySlug = new Map((roleRows as any[]).map((r: any) => [r.slug as string, r]));

      return {
        ...stats,
        window,
        scan,
        builddActions,
        groups: stats.groups.map(g => ({
          ...g,
          label: g.key === UNASSIGNED_ROLE
            ? 'General-purpose'
            : `${roleBySlug.get(g.roleSlug ?? g.key)?.name ?? g.roleSlug ?? g.key}${g.roleSource === 'inferred' ? INFERRED_ROLE_SUFFIX : ''}`,
          color: roleBySlug.get(g.roleSlug ?? g.key)?.color ?? '#888',
        })),
      };
    })().catch(() => null)
      : null,

    // Aggregated worker failure analytics for the selected window
need('failureAnalytics') ? getFailureAnalytics(scopedWsIds, window).catch(() => null as FailureAnalytics | null) : null,
    // Failures' headline rate: three counts in SQL, not the whole report.
    need('failureHeadline') ? getFailureTotals(scopedWsIds, window).catch(() => null) : null,
    // The gate ledger over the same window — server-side refusals, deferrals,
    // advisory warnings and bypasses. Disjoint from the failures above by
    // construction: a caller the platform refused never became a worker, so it
    // can never appear in both.
need('gateAnalytics') ? getGateAnalytics(scopedWsIds, window).catch(() => null) : null,
    // Backends stranding pending work: a credential nobody configured means
    // those tasks can never be claimed, and the Problems list would otherwise
    // read "All systems healthy" while the queue can never drain.
    need('strandedBackends')
      ? getBackendStrandSummary({ teamId: activeTeamId, workspaceIds: scopedWsIds }).catch(() => null)
      : null,

    // Delegated-work TREND: what share of a session's total agent-effort
    // (wall clock + background subagent time) was handed to background
    // subagents. Computed, stored on every terminal worker, and read by
    // nobody until now — see subagent-time.ts for why background time is
    // additional effort rather than a slice of wall clock.
    need('subagentDelegation')
      ? (async (): Promise<SubagentDelegationPanel | null> => {
      const windowStart = new Date(Date.now() - parseWindowMs(window));
      const rows = await fetchSubagentTimeRows({ workspaceIds: scopedWsIds, windowStart });
      return buildSubagentDelegationPanel({
        rows,
        windowStart,
        rowLimit: SUBAGENT_TIME_ROW_LIMIT,
        capturedSince: SUBAGENT_TIME_CAPTURED_SINCE,
      });
    })().catch(() => null as SubagentDelegationPanel | null)
      : null as SubagentDelegationPanel | null,

    // Error-trace pattern rollup TREND: which scanned error pattern
    // (`worker_error_traces.pattern`) is costing us the most, ranked by
    // distinct workers whose session ended in failure while it fired — not
    // raw occurrence count, which a chatty-but-harmless pattern would win.
    // Computed, stored, and read by nobody outside ad-hoc SQL until now — see
    // error-pattern-cost.ts for the ranking argument and the scanner-gating
    // discontinuity this clamps around.
    need('errorPatterns')
      ? (async (): Promise<ErrorPatternPanel | null> => {
      const windowStart = new Date(Date.now() - parseWindowMs(window));
      const effectiveStart = errorPatternEffectiveStart(windowStart);
      const [rows, scannedWorkers] = await Promise.all([
        fetchErrorPatternRows({ workspaceIds: scopedWsIds, windowStart }),
        // Population is workers COMPLETED in the (gate-clamped) window — same
        // terminal-only convention subagent-time and failure-analytics use on
        // this page, and the same reasoning: an in-flight worker's traces are
        // provisional the way its outcome is.
        countWorkersInWindow({ workspaceIds: scopedWsIds, windowStart: effectiveStart }),
      ]);
      return buildErrorPatternPanel({
        rows,
        scannedWorkers,
        windowStart,
        rowLimit: ERROR_PATTERN_ROW_LIMIT,
        gatedSince: ERROR_TRACE_GATED_SINCE,
      });
    })().catch(() => null as ErrorPatternPanel | null)
      : null as ErrorPatternPanel | null,

    // Dispatch transport STATE for the scoped workspaces: the same report the
    // dispatch_health MCP action prints. Postgres counts plus one short Worker
    // /health probe; a failure hides the section, never the page.
need('dispatchHealth') ? getDispatchHealth(scopedWsIds).catch(() => null) : null,

    // What is failing, one group per cause: failed workers in the window plus
    // the error-trace patterns seen on them (lib/health-failure-groups.ts).
    need('failureGroups')
      ? (async (): Promise<(FailureGroupsView & { truncated: boolean }) | null> => {
      const windowStart = new Date(Date.now() - parseWindowMs(window));
      // One read: each failed worker with its task's title and the error-trace
      // patterns seen on it. The error is bounded: a cause is named from the
      // start of the text, and the drill-down shows a sample, never a whole
      // log (spec 3ef37387 R-9).
      const failed = await db
        .select({
          id: workers.id,
          taskId: workers.taskId,
          workspaceId: workers.workspaceId,
          exitCause: workers.exitCause,
          completedAt: workers.completedAt,
          error: sql<string | null>`left(${workers.error}, ${FAILURE_ERROR_CHARS})`,
          taskTitle: tasks.title,
          patterns: sql<string[]>`(select coalesce(jsonb_agg(distinct ${workerErrorTraces.pattern}), '[]'::jsonb) from ${workerErrorTraces} where ${workerErrorTraces.workerId} = ${workers.id})`,
        })
        .from(workers)
        .leftJoin(tasks, eq(tasks.id, workers.taskId))
        .where(and(
          inArray(workers.workspaceId, scopedWsIds),
          inArray(workers.status, [...FAILED_WORKER_STATUSES]),
          sql`${workers.completedAt} >= ${windowStart}`,
        ))
        .orderBy(desc(workers.completedAt))
        .limit(FAILURE_GROUP_WORKER_LIMIT);
      const view = buildFailureGroups({
        failures: failed.map(w => ({
          workerId: w.id,
          taskId: w.taskId ?? null,
          taskTitle: w.taskTitle ?? null,
          workspaceName: wsById.get(w.workspaceId) ?? '(unknown)',
          error: w.error ?? null,
          exitCause: w.exitCause ?? null,
          completedAt: (w.completedAt ?? new Date()).toISOString(),
        })),
        traces: failed.flatMap(w => (Array.isArray(w.patterns) ? w.patterns : []).map(pattern => ({ workerId: w.id, pattern }))),
      });
      return { ...view, truncated: failed.length >= FAILURE_GROUP_WORKER_LIMIT };
    })().catch(() => null)
      : null,

    // Agent runs' access: grant failures with their fix, refusals by reason.
    // A read failure hides the section, never the page.
    need('agentAccess') ? loadAgentAccessReport(scopedWsIds).catch(() => null) : null,
    // Pending tasks as the claim's isolation gate sees them, so each runner's
    // detail can say how many it refuses (runner-isolation-health.ts).
    need('runners')
      ? loadPendingIsolationTasks(scopedWsIds, activeTeamId).catch(() => [] as PendingIsolationTask[])
      : [] as PendingIsolationTask[],
  ]);
  // An unknown or stale probe refuses every task, so any waiting one makes it a Problem.
  const protectedWorkPending = pendingIsolation.length > 0;
  // Only runners seen recently are listed and counted; a long-gone one is not part of the fleet.
  const runners = heartbeats.filter(r => isRunnerRecentlySeen(r.lastHeartbeatAt, now));
  const onlineRunners = runners.filter(r => isRunnerOnline(r.lastHeartbeatAt, now, r.presenceConnected));
  const isolationStranded = isolationStrandedCount(onlineRunners.map(r => r.isolation), pendingIsolation);
  for (const r of runners) r.isolationBlocked = isolationBlockedCounts(r.isolation, pendingIsolation);

  // A runner's own Codex login serves Codex work with no stored credential.
  const strandedBackends: StrandedBackendRow[] = withoutRunnerServedStrands(strandSummary?.backends ?? [], runners, now)
    .filter((b) => b.strandedPending > 0)
    .map((b) => ({
      backend: b.backend,
      label: b.label,
      strandedPending: b.strandedPending,
      enabledForTeam: b.enabledForTeam,
      sampleTasks: b.sampleTasks,
    }));

  const serializedSchedules: ScheduleRow[] = (scheduleRows as any[])
    .map((s: any) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      workspaceName: wsById.get(s.workspaceId) ?? '(unknown)',
      name: s.name,
      cronExpression: s.cronExpression,
      timezone: s.timezone,
      enabled: s.enabled,
      nextRunAt: s.nextRunAt ? s.nextRunAt.toISOString() : null,
      lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
      lastError: s.lastError,
      consecutiveFailures: s.consecutiveFailures,
      totalRuns: s.totalRuns,
      createdAt: s.createdAt ? s.createdAt.toISOString() : null,
      taskTitle: s.taskTemplate?.title ?? '',
      // The join can repeat a schedule linked from two missions; the first wins below.
      missionTitle: s.missionTitle,
      missionId: s.missionId ?? null,
      isHeartbeat: !!s.heartbeat,
    }))
    .filter((s: ScheduleRow, i: number, all: ScheduleRow[]) => all.findIndex(o => o.id === s.id) === i)
    .sort((a: ScheduleRow, b: ScheduleRow) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return (a.nextRunAt ?? '9999') < (b.nextRunAt ?? '9999') ? -1 : 1;
    });

  // Orphaned PRs: worker rows the reconcile sweep gave up on
  // (prLifecycleStatus='unresolvable' — see lib/pr-freshness.ts). They are OFF
  // Home by design, because nobody can act on a PR buildd cannot even resolve.
  // They surface here instead, which is what stops "retire it" from meaning
  // "silently drop it" (facae217 AC-6).
  const orphanedPrs: OrphanedPrRow[] = !need('orphanedPrs') ? [] : await db.query.workers
    .findMany({
      where: sqlWhere(and(
        inArray(workers.workspaceId, scopedWsIds),
        eq(workers.prLifecycleStatus, 'unresolvable'),
      )),
      columns: {
        id: true, workspaceId: true, prUrl: true, prNumber: true,
        prUnresolvableReason: true, prCheckFailureCount: true,
        prLastCheckedAt: true, completedAt: true, createdAt: true,
      },
      with: { task: { columns: { id: true, title: true } } },
      orderBy: sqlOrderBy(desc(workers.prLastCheckedAt)),
      limit: 25,
    })
    .then(rows => rows.map((w): OrphanedPrRow => ({
      workerId: w.id,
      workspaceName: wsById.get(w.workspaceId) ?? '(unknown)',
      taskId: (w.task as { id: string } | null)?.id ?? null,
      taskTitle: (w.task as { title: string } | null)?.title ?? null,
      prUrl: w.prUrl,
      prNumber: w.prNumber,
      reason: w.prUnresolvableReason,
      failureCount: w.prCheckFailureCount ?? 0,
      lastCheckedAt: w.prLastCheckedAt ? w.prLastCheckedAt.toISOString() : null,
      prOpenedAt: (w.completedAt ?? w.createdAt)?.toISOString() ?? null,
    })))
    .catch(() => [] as OrphanedPrRow[]);

  // Team experiments (model routing A/B). Operator-only rows are dropped for
  // everyone else inside the loader; a failure hides the section, never the page.
  const runnerLanes = need('runnerLanes')
    ? await loadRunnersFleet({ teamId: activeTeamId, wsIds: scopedWsIds, now, viewerId: userId })
      .then(async lanes => ({ ...lanes, missions: await loadLaneMissions(lanes.fleet, activeTeamId).catch(() => ({})) }))
      .catch(() => null)
    : null;

  const claimPlans = need('claimPlans')
    ? await loadClaimPlanHealth({ workspaceIds: scopedWsIds, since: new Date(now - parseWindowMs(window)) }).catch(() => null)
    : null;

  const experiments = need('experiments') ? await loadHealthExperiments(activeTeamId, userId, operator).catch(() => null) : null;

  return {
    kind: 'ok',
    data: {
      orphanedPrs,
      runners,
      usageStats,
      consumption: consumption ?? null,
      schedules: serializedSchedules,
      recentFailures: recentFailureRows ?? [],
      credentialHealth: credentialHealthRows ?? [],
      strandedBackends,
      wsFilter: wsFilter ?? null,
      budgetForecast: budgetForecast ?? null,
      failureAnalytics: failureAnalytics ?? null,
      failureHeadline: failureHeadline ?? null,
      gateAnalytics: gateAnalytics ?? null,
      window,
      subagentDelegation: subagentDelegation ?? null,
      errorPatterns: errorPatterns ?? null,
      experiments,
      dispatchHealth: dispatchHealth ?? null,
      failureGroups: failureGroups ?? null,
      agentAccess: agentAccess ?? null,
      runnerLanes,
      seesTeamWork: need('runnerLanes')
        ? await can({ kind: 'user', userId }, 'view_team_usage', activeTeamId).catch(() => false)
        : false,
      claimPlans,
      protectedWorkPending,
      isolationStranded,
      // The workspaces the lanes read, for the page's live refresh.
      laneWorkspaceIds: runnerLanes ? scopedWsIds : [],
      pausedWorkspaces: (teamWorkspaceRows as Array<{ id: string; name: string; pausedUntil: Date | null }>)
        .filter(w => w.pausedUntil && w.pausedUntil.getTime() > now)
        .map(w => ({ id: w.id, name: w.name, pausedUntil: w.pausedUntil!.toISOString() })),
      now,
    },
  };
}

/** buildd action events counted per action, most-called first. */
function countActions(rows: ReadonlyArray<{ action: string | null }>): { totalCalls: number; actions: Array<{ action: string; calls: number }> } {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.action) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
  const actions = [...counts.entries()]
    .map(([action, calls]) => ({ action, calls }))
    .sort((a, b) => b.calls - a.calls || a.action.localeCompare(b.action));
  return { totalCalls: actions.reduce((sum, a) => sum + a.calls, 0), actions };
}

/** Enough pending tasks to count what blocks them; a larger backlog reads as at least this many. */
const PENDING_ISOLATION_LIMIT = 500;

/**
 * Pending tasks in the scoped workspaces, resolved as the claim's isolation
 * gate resolves them. The scoped workspaces all belong to the active team, so
 * one team size serves the single-owner default (isolation-policy.ts).
 */
async function loadPendingIsolationTasks(workspaceIds: string[], teamId: string): Promise<PendingIsolationTask[]> {
  const { rows, team } = await readRound({
    rows: db.select({
      backend: tasks.backend,
      kind: tasks.kind,
      sandboxMode: sql<string | null>`${tasks.context}->>'sandboxMode'`,
      isolationPolicy: sql<string | null>`${workspaces.gitConfig}->>'isolationPolicy'`,
      accessMode: workspaces.accessMode,
    })
      .from(tasks)
      .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      .where(and(inArray(tasks.workspaceId, workspaceIds), eq(tasks.status, 'pending')))
      .limit(PENDING_ISOLATION_LIMIT),
    team: db.select({ n: count() }).from(teamMembers).where(eq(teamMembers.teamId, teamId)),
  });
  const teamSize = team ? Number(team[0]?.n ?? 0) : null;
  return rows.map(r => pendingIsolationTask({
    backend: r.backend,
    kind: r.kind,
    context: { sandboxMode: r.sandboxMode },
    // A JSON null reads as no policy, as the claim's undefined does.
    isolationPolicy: r.isolationPolicy ?? undefined,
    accessMode: r.accessMode,
    // The claim reads the team size only when the workspace sets no policy.
  }, r.isolationPolicy == null ? teamSize : null));
}
