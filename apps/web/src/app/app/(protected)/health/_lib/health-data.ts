import 'server-only';
import { db } from '@buildd/core/db';
import { workspaces, tasks, workers, workspaceSkills, taskSchedules, missions, secrets, workerErrorTraces } from '@buildd/core/db/schema';
import { and, eq, inArray, desc, sql, or, isNull } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { getRunnerHeartbeats, type RunnerHeartbeat } from '@/lib/runner-heartbeats';
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
  parseFailureWindow,
  type FailureAnalytics,
  type FailureWindow,
} from '@/lib/failure-analytics';
import { getGateAnalytics } from '@/lib/gate-analytics-query';
import { getBackendStrandSummary } from '@/lib/backend-strand';
import type { CbmHealthSummary } from '@/lib/cbm-insight';
import { fetchCbmSummary } from '@/lib/cbm-insight-query';
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
import { countWorkersInWindow } from '@/lib/action-events';
import { loadHealthExperiments } from '@/lib/health-experiments';
import { getDispatchHealth } from '@/lib/dispatch-health';
import { buildFailureGroups, type FailureGroupsView } from '@/lib/health-failure-groups';
import { FAILED_WORKER_STATUSES } from '@buildd/shared';

export type { BudgetForecast, FailureAnalytics, FailureWindow };
export type { GateAnalytics } from '@buildd/shared';
export type { CbmHealthSummary };
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
  sampleTasks: Array<{ id: string; title: string; workspaceName: string | null }>;
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
 * codebase-graph query. The sources and their shapes are unchanged from the
 * single Health page they came from.
 */
export type HealthDataKey =
  | 'runners' | 'usageStats' | 'schedules' | 'recentFailures' | 'credentials'
  | 'budgetForecast' | 'consumption' | 'failureAnalytics' | 'gateAnalytics'
  | 'strandedBackends' | 'cbm' | 'subagentDelegation' | 'errorPatterns'
  | 'dispatchHealth' | 'orphanedPrs' | 'experiments' | 'failureGroups';

export type HealthPageKey = 'overview' | 'failures' | 'runners' | 'operator';

export const HEALTH_PAGE_DATA: Record<HealthPageKey, ReadonlySet<HealthDataKey>> = {
  // Problems: broken credentials, stranded backends, offline runners, failing schedules, 24h failures.
  // failureGroups feeds the Overview's top failures (TopFailureGroups).
  overview: new Set(['runners', 'schedules', 'recentFailures', 'credentials', 'strandedBackends', 'failureGroups']),
  // failureAnalytics stays for the headline rate (failed / finished).
  failures: new Set(['failureAnalytics', 'failureGroups']),
  runners: new Set(['runners', 'budgetForecast', 'credentials', 'schedules']),
  operator: new Set([
    'dispatchHealth', 'gateAnalytics', 'experiments', 'cbm', 'subagentDelegation',
    'usageStats', 'orphanedPrs', 'errorPatterns', 'consumption', 'failureAnalytics',
  ]),
};

/** Failed workers read for the grouped view. Newest first; older ones drop past the cap. */
export const FAILURE_GROUP_WORKER_LIMIT = 500;

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
  gateAnalytics: import('@buildd/shared').GateAnalytics | null;
  window: FailureWindow;
  cbm: CbmHealthSummary | null;
  subagentDelegation: SubagentDelegationPanel | null;
  errorPatterns: ErrorPatternPanel | null;
  experiments: Awaited<ReturnType<typeof loadHealthExperiments>> | null;
  dispatchHealth: Awaited<ReturnType<typeof getDispatchHealth>> | null;
  /** What is failing, one group per cause (lib/health-failure-groups.ts). */
  failureGroups: (FailureGroupsView & { truncated: boolean }) | null;
  now: number;
}

export type HealthLoad = { kind: 'no-workspaces' } | { kind: 'ok'; data: HealthData };

/**
 * Load one Health page's data for the signed-in user (the caller has already
 * checked there is a user and a team).
 */
export async function loadHealth({
  page, userId, teamIds, searchParams,
}: {
  page: HealthPageKey;
  userId: string;
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
    .select({ id: workspaces.id, name: workspaces.name, teamId: workspaces.teamId })
    .from(workspaces)
    .where(eq(workspaces.teamId, activeTeamId));

  const teamWorkspaceIds = (teamWorkspaceRows as any[]).map((w: any) => w.id as string);
  if (teamWorkspaceIds.length === 0) return { kind: 'no-workspaces' };

  const scopedWsIds = wsFilter && teamWorkspaceIds.includes(wsFilter)
    ? [wsFilter]
    : teamWorkspaceIds;

  const wsById = new Map((teamWorkspaceRows as any[]).map((w: any) => [w.id as string, w.name as string] as const));

  // Parallel fetches: runners, usage, schedules, recent failures, credential
  // health, budget forecast, consumption, aggregated failure analytics, and
  // backends stranding pending work
  const [
    runners,
    usageStats,
    scheduleRows,
    recentFailureRows,
    credentialHealthRows,
    budgetForecast,
    consumption,
    failureAnalytics,
    gateAnalytics,
    strandSummary,
    cbmSummary,
    subagentDelegation,
    errorPatterns,
    dispatchHealth,
    failureGroups,
  ] = await Promise.all([
    // Runner heartbeats relevant to the scoped workspaces
    need('runners')
      ? getRunnerHeartbeats(activeTeamId, scopedWsIds).catch(() => [] as RunnerHeartbeat[])
      : [] as RunnerHeartbeat[],

    // Task-keyed totals over the page window (was a fixed 30d role rollup).
    // Exclude attempt tasks (parentTaskId IS NOT NULL) so CI retries don't inflate counts.
    need('usageStats')
      ? (async (): Promise<UsageStats | null> => {
      const windowStart = new Date(Date.now() - parseWindowMs(window));
      const recentTasks = await db.query.tasks.findMany({
        where: and(
          inArray(tasks.workspaceId, scopedWsIds),
          sql`${tasks.createdAt} >= ${windowStart}`,
          isNull(tasks.parentTaskId),
        ),
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

    // Schedules across the scoped workspaces, with mission linkage
    need('schedules')
      ? (async () => {
      const schedules = await db
        .select()
        .from(taskSchedules)
        .where(inArray(taskSchedules.workspaceId, scopedWsIds));
      if (schedules.length === 0) return [] as (typeof schedules[number] & { missionTitle: string | null })[];

      const linkedMissions = await db
        .select({ scheduleId: missions.scheduleId, title: missions.title })
        .from(missions)
        .where(inArray(missions.scheduleId, schedules.map((s: any) => s.id as string)));
      const missionBySchedule = new Map(
        (linkedMissions as any[])
          .filter((m: any) => m.scheduleId)
          .map((m: any) => [m.scheduleId as string, m.title as string] as const),
      );
      return (schedules as any[]).map((s: any) => ({
        ...s,
        missionTitle: missionBySchedule.get(s.id) ?? null,
        isHeartbeat: !!(s.taskTemplate?.context?.heartbeat),
      }));
    })().catch(() => [] as any[])
      : [] as any[],

    // Recent worker failures across scoped workspaces (past 24h)
    need('recentFailures')
      ? (async (): Promise<RecentFailure[]> => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const failedWorkers = await db.query.workers.findMany({
        where: and(
          inArray(workers.workspaceId, scopedWsIds),
          eq(workers.status, 'failed'),
          sql`${workers.completedAt} >= ${cutoff}`,
        ),
        columns: { id: true, taskId: true, workspaceId: true, error: true, completedAt: true },
        orderBy: [desc(workers.completedAt)],
        limit: 20,
      });
      if (failedWorkers.length === 0) return [];

      const taskIds = (failedWorkers as any[]).flatMap((w: any) => w.taskId ? [w.taskId as string] : []);
      const taskTitles = taskIds.length
        ? await db.query.tasks.findMany({
            where: inArray(tasks.id, taskIds),
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
      const credRows = await db.query.secrets.findMany({
        where: and(
          eq(secrets.teamId, activeTeamId),
          or(
            eq(secrets.purpose, 'oauth_token'),
            eq(secrets.purpose, 'anthropic_api_key'),
            eq(secrets.purpose, 'codex_credential'),
          ),
        ),
        columns: {
          id: true,
          purpose: true,
          healthStatus: true,
          consecutiveAuthFailures: true,
          lastFailureAt: true,
          lastFailureMessage: true,
          lastSuccessAt: true,
          lastVerifiedAt: true,
        },
      });
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
need('budgetForecast') ? getBudgetForecast(activeTeamId, scopedWsIds).catch(() => null as BudgetForecast | null) : null,
    // Consumption: tokens / cost / turns / tool calls per task, by role. TREND —
    // obeys the page window (it used to be pinned to 7d while the section above
    // it was pinned to 30d, so the page published two windows and named neither).
    need('consumption')
      ? (async (): Promise<ConsumptionStats | null> => {
      const windowStart = new Date(Date.now() - parseWindowMs(window));
      const rows = await fetchUsageRows({ workspaceIds: scopedWsIds, windowStart });
      if (rows.length === 0) return null;

      const stats = computeUsageStats(rows, 'role');
      const scan = describeScan(rows, windowStart, USAGE_ROW_LIMIT);
      const slugs = [...new Set(stats.groups.map(g => g.roleSlug).filter((k): k is string => !!k))];
      const roleRows = slugs.length > 0
        ? await db.query.workspaceSkills.findMany({
            where: and(
              inArray(workspaceSkills.workspaceId, scopedWsIds),
              eq(workspaceSkills.isRole, true),
              inArray(workspaceSkills.slug, slugs),
            ),
            columns: { slug: true, name: true, color: true },
          })
        : [];
      const roleBySlug = new Map((roleRows as any[]).map((r: any) => [r.slug as string, r]));

      return {
        ...stats,
        window,
        scan,
        groups: stats.groups.map(g => ({
          ...g,
          label: g.key === UNASSIGNED_ROLE
            ? 'No role'
            : `${roleBySlug.get(g.roleSlug ?? g.key)?.name ?? g.roleSlug ?? g.key}${g.roleSource === 'inferred' ? INFERRED_ROLE_SUFFIX : ''}`,
          color: roleBySlug.get(g.roleSlug ?? g.key)?.color ?? '#888',
        })),
      };
    })().catch(() => null)
      : null,

    // Aggregated worker failure analytics for the selected window
need('failureAnalytics') ? getFailureAnalytics(scopedWsIds, window).catch(() => null as FailureAnalytics | null) : null,
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

    // Codebase graph (CBM). TREND — obeys the page window (was pinned to 7d).
    // Same aggregation the /api/cbm/metrics endpoint returns — the page used to
    // show CBM only as rows in the generic top-tools list, which cannot
    // distinguish "mounted and never queried" from healthy. Shared with the
    // usage drill-down, which runs the same cohort rules on its own window.
    need('cbm')
      ? fetchCbmSummary({
      workspaceIds: scopedWsIds,
      window,
      windowStart: new Date(Date.now() - parseWindowMs(window)),
    }).catch(() => null)
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
      const failed = await db.query.workers.findMany({
        where: and(
          inArray(workers.workspaceId, scopedWsIds),
          inArray(workers.status, [...FAILED_WORKER_STATUSES]),
          sql`${workers.completedAt} >= ${windowStart}`,
        ),
        columns: { id: true, taskId: true, workspaceId: true, error: true, exitCause: true, completedAt: true },
        with: { task: { columns: { title: true } } },
        orderBy: [desc(workers.completedAt)],
        limit: FAILURE_GROUP_WORKER_LIMIT,
      });
      const ids = (failed as Array<{ id: string }>).map(w => w.id);
      const traces = ids.length
        ? await db
            .selectDistinct({ workerId: workerErrorTraces.workerId, pattern: workerErrorTraces.pattern })
            .from(workerErrorTraces)
            .where(inArray(workerErrorTraces.workerId, ids))
        : [];
      const view = buildFailureGroups({
        failures: (failed as any[]).map(w => ({
          workerId: w.id,
          taskId: w.taskId ?? null,
          taskTitle: (w.task as { title: string } | null)?.title ?? null,
          workspaceName: wsById.get(w.workspaceId) ?? '(unknown)',
          error: w.error ?? null,
          exitCause: w.exitCause ?? null,
          completedAt: (w.completedAt ?? new Date()).toISOString(),
        })),
        traces: traces as Array<{ workerId: string; pattern: string }>,
      });
      return { ...view, truncated: failed.length >= FAILURE_GROUP_WORKER_LIMIT };
    })().catch(() => null)
      : null,
  ]);

  const strandedBackends: StrandedBackendRow[] = (strandSummary?.backends ?? [])
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
      missionTitle: s.missionTitle,
      isHeartbeat: !!s.isHeartbeat,
    }))
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
      where: and(
        inArray(workers.workspaceId, scopedWsIds),
        eq(workers.prLifecycleStatus, 'unresolvable'),
      ),
      columns: {
        id: true, workspaceId: true, prUrl: true, prNumber: true,
        prUnresolvableReason: true, prCheckFailureCount: true,
        prLastCheckedAt: true, completedAt: true, createdAt: true,
      },
      with: { task: { columns: { id: true, title: true } } },
      orderBy: desc(workers.prLastCheckedAt),
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

  // Team experiments (model routing A/B). Admins-only rows are dropped for
  // members inside the loader; a failure hides the section, never the page.
  const experiments = need('experiments') ? await loadHealthExperiments(activeTeamId, userId).catch(() => null) : null;

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
      gateAnalytics: gateAnalytics ?? null,
      window,
      cbm: cbmSummary ?? null,
      subagentDelegation: subagentDelegation ?? null,
      errorPatterns: errorPatterns ?? null,
      experiments,
      dispatchHealth: dispatchHealth ?? null,
      failureGroups: failureGroups ?? null,
      now,
    },
  };
}
