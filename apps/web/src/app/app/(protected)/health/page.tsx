import { db } from '@buildd/core/db';
import { workspaces, tasks, workers, workspaceSkills, taskSchedules, missions, secrets } from '@buildd/core/db/schema';
import { and, eq, inArray, desc, sql, or, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { getRunnerHeartbeats, type RunnerHeartbeat } from '@/lib/runner-heartbeats';
import { getBudgetForecast, type BudgetForecast } from '@/lib/budget-forecast';
import {
  computeUsageStats,
  describeScan,
  parseWindowMs,
  UNASSIGNED_ROLE,
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
import { getBackendStrandSummary } from '@/lib/backend-strand';
import type { CbmHealthSummary } from '@/lib/cbm-insight';
import { fetchCbmSummary } from '@/lib/cbm-insight-query';
import { HealthClient } from './HealthClient';

export type { BudgetForecast, FailureAnalytics, FailureWindow };
export type { CbmHealthSummary };

export const dynamic = 'force-dynamic';

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

export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }>;
}) {
  // `?window=` is the primary param (24h|7d|30d). `?failureWindow=` is the
  // deprecated predecessor — still read as a fallback alias for old links, but
  // never written by new navigation. No expiry is set for the alias (spec §7.7
  // left this open deliberately).
  const { workspace: wsFilter, window: rawWindow, failureWindow: rawFailureWindow } = await searchParams;
  // ONE window for the whole page. Every TREND section reads it; the three
  // sections that structurally cannot (Problems' 24h triage feed, the budget
  // forecast's provider session window, and every LIFETIME counter) say so
  // inline rather than silently ignoring it — see spec §2.3.
  const window = parseFailureWindow(rawWindow ?? rawFailureWindow);
  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="hidden md:block text-2xl font-bold mb-2">Health</h1>
        <p className="text-sm text-text-tertiary">No team found.</p>
      </div>
    );
  }

  const cookieStore = await cookies();
  const activeTeamId =
    (await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value)) ?? teamIds[0];

  // Workspaces for the active team
  const teamWorkspaceRows = await db
    .select({ id: workspaces.id, name: workspaces.name, teamId: workspaces.teamId })
    .from(workspaces)
    .where(eq(workspaces.teamId, activeTeamId));

  const teamWorkspaceIds = (teamWorkspaceRows as any[]).map((w: any) => w.id as string);
  if (teamWorkspaceIds.length === 0) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="hidden md:block text-2xl font-bold mb-2">Health</h1>
        <p className="text-sm text-text-tertiary">No workspaces yet.</p>
      </div>
    );
  }

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
    strandSummary,
    cbmSummary,
  ] = await Promise.all([
    // Runner heartbeats relevant to the scoped workspaces
    getRunnerHeartbeats(activeTeamId, scopedWsIds)
      .catch(() => [] as RunnerHeartbeat[]),

    // Task-keyed totals over the page window (was a fixed 30d role rollup).
    // Exclude attempt tasks (parentTaskId IS NOT NULL) so CI retries don't inflate counts.
    (async (): Promise<UsageStats | null> => {
      const windowStart = new Date(Date.now() - parseWindowMs(window));
      const recentTasks = await db.query.tasks.findMany({
        where: and(
          inArray(tasks.workspaceId, scopedWsIds),
          sql`${tasks.createdAt} >= ${windowStart}`,
          isNull(tasks.parentTaskId),
        ),
        columns: { roleSlug: true, status: true },
      });

      if (recentTasks.length === 0) return null;

      let completed = 0;
      let failed = 0;
      let unassigned = 0;
      for (const t of recentTasks) {
        if (t.status === 'completed') completed++;
        if (t.status === 'failed') failed++;
        if (!t.roleSlug) unassigned++;
      }

      return { total: recentTasks.length, completed, failed, unassigned };
    })().catch(() => null),

    // Schedules across the scoped workspaces, with mission linkage
    (async () => {
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
    })().catch(() => [] as any[]),

    // Recent worker failures across scoped workspaces (past 24h)
    (async (): Promise<RecentFailure[]> => {
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
    })().catch(() => [] as RecentFailure[]),

    // Backend credentials for this team — ALL of them, not just the broken
    // ones. Problems renders the degraded/revoked rows; State renders credential
    // health as a STATE with its own freshness, which needs the healthy rows.
    (async (): Promise<CredentialHealthItem[]> => {
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
    })().catch(() => [] as CredentialHealthItem[]),

    // Budget forecast
    getBudgetForecast(activeTeamId, scopedWsIds).catch(() => null as BudgetForecast | null),

    // Consumption: tokens / cost / turns / tool calls per task, by role. TREND —
    // obeys the page window (it used to be pinned to 7d while the section above
    // it was pinned to 30d, so the page published two windows and named neither).
    (async (): Promise<ConsumptionStats | null> => {
      const windowStart = new Date(Date.now() - parseWindowMs(window));
      const rows = await fetchUsageRows({ workspaceIds: scopedWsIds, windowStart });
      if (rows.length === 0) return null;

      const stats = computeUsageStats(rows, 'role');
      const scan = describeScan(rows, windowStart, USAGE_ROW_LIMIT);
      const slugs = stats.groups.map(g => g.key).filter(k => k !== UNASSIGNED_ROLE);
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
          label: roleBySlug.get(g.key)?.name ?? (g.key === UNASSIGNED_ROLE ? 'No role' : g.key),
          color: roleBySlug.get(g.key)?.color ?? '#888',
        })),
      };
    })().catch(() => null),

    // Aggregated worker failure analytics for the selected window
    getFailureAnalytics(scopedWsIds, window).catch(() => null as FailureAnalytics | null),

    // Backends stranding pending work: a credential nobody configured means
    // those tasks can never be claimed, and the Problems list would otherwise
    // read "All systems healthy" while the queue can never drain.
    getBackendStrandSummary({ teamId: activeTeamId, workspaceIds: scopedWsIds })
      .catch(() => null),

    // Codebase graph (CBM). TREND — obeys the page window (was pinned to 7d).
    // Same aggregation the /api/cbm/metrics endpoint returns — the page used to
    // show CBM only as rows in the generic top-tools list, which cannot
    // distinguish "mounted and never queried" from healthy. Shared with the
    // usage drill-down, which runs the same cohort rules on its own window.
    fetchCbmSummary({
      workspaceIds: scopedWsIds,
      window,
      windowStart: new Date(Date.now() - parseWindowMs(window)),
    }).catch(() => null),
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
  const orphanedPrs: OrphanedPrRow[] = await db.query.workers
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

  return (
    <HealthClient
      orphanedPrs={orphanedPrs}
      runners={runners}
      usageStats={usageStats}
      consumption={consumption ?? null}
      schedules={serializedSchedules}
      recentFailures={recentFailureRows ?? []}
      credentialHealth={credentialHealthRows ?? []}
      strandedBackends={strandedBackends}
      teamWorkspaces={(teamWorkspaceRows as any[]).map((w: any) => ({ id: w.id as string, name: w.name as string }))}
      wsFilter={wsFilter ?? null}
      budgetForecast={budgetForecast ?? null}
      failureAnalytics={failureAnalytics ?? null}
      window={window}
      cbm={cbmSummary ?? null}
    />
  );
}
