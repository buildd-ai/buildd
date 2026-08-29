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
  parseWindowMs,
  UNASSIGNED_ROLE,
  type GroupEntry,
  type UsageStats as UsageRollup,
} from '@/lib/usage-stats';
import { fetchUsageRows } from '@/lib/usage-stats-query';
import { HealthClient } from './HealthClient';

export type { BudgetForecast };

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
  consecutiveFailures: number;
  totalRuns: number;
  taskTitle: string;
  missionTitle: string | null;
  isHeartbeat: boolean;
}

export interface UsageStats {
  total: number;
  completed: number;
  failed: number;
  unassigned: number;
  byRole: { slug: string; name: string; color: string; completed: number; failed: number; total: number }[];
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
}

export interface RecentFailure {
  workerId: string;
  taskId: string | null;
  taskTitle: string;
  workspaceName: string;
  error: string | null;
  completedAt: string;
}

export interface CredentialHealthItem {
  id: string;
  purpose: string;
  healthStatus: 'degraded' | 'revoked';
  consecutiveAuthFailures: number;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  lastSuccessAt: string | null;
  lastVerifiedAt: string | null;
}

export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  const { workspace: wsFilter } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-2">Health</h1>
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
        <h1 className="text-2xl font-bold mb-2">Health</h1>
        <p className="text-sm text-text-tertiary">No workspaces yet.</p>
      </div>
    );
  }

  const scopedWsIds = wsFilter && teamWorkspaceIds.includes(wsFilter)
    ? [wsFilter]
    : teamWorkspaceIds;

  const wsById = new Map((teamWorkspaceRows as any[]).map((w: any) => [w.id as string, w.name as string] as const));

  // Parallel fetches: runners, usage, schedules, recent failures, credential health, budget forecast
  const [runners, usageStats, scheduleRows, recentFailureRows, credentialHealthRows, budgetForecast, consumption] = await Promise.all([
    // Runner heartbeats relevant to the scoped workspaces
    getRunnerHeartbeats(activeTeamId, scopedWsIds)
      .catch(() => [] as RunnerHeartbeat[]),

    // Usage stats (last 30 days)
    // Exclude attempt tasks (parentTaskId IS NOT NULL) so CI retries don't inflate counts.
    (async (): Promise<UsageStats | null> => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentTasks = await db.query.tasks.findMany({
        where: and(
          inArray(tasks.workspaceId, scopedWsIds),
          sql`${tasks.createdAt} >= ${thirtyDaysAgo}`,
          isNull(tasks.parentTaskId),
        ),
        columns: { roleSlug: true, status: true },
      });

      if (recentTasks.length === 0) return null;

      const byRole: Record<string, { completed: number; failed: number; total: number }> = {};
      let totalCompleted = 0;
      let totalFailed = 0;
      let unassigned = 0;

      for (const t of recentTasks) {
        if (t.status === 'completed') totalCompleted++;
        if (t.status === 'failed') totalFailed++;
        if (t.roleSlug) {
          if (!byRole[t.roleSlug]) byRole[t.roleSlug] = { completed: 0, failed: 0, total: 0 };
          byRole[t.roleSlug].total++;
          if (t.status === 'completed') byRole[t.roleSlug].completed++;
          if (t.status === 'failed') byRole[t.roleSlug].failed++;
        } else {
          unassigned++;
        }
      }

      const roleSlugs = Object.keys(byRole);
      let roleInfo: Record<string, { name: string; color: string }> = {};
      if (roleSlugs.length > 0) {
        const skills = await db.query.workspaceSkills.findMany({
          where: and(
            inArray(workspaceSkills.workspaceId, scopedWsIds),
            eq(workspaceSkills.isRole, true),
            inArray(workspaceSkills.slug, roleSlugs),
          ),
          columns: { slug: true, name: true, color: true },
        });
        for (const s of skills) {
          roleInfo[s.slug] = { name: s.name, color: s.color ?? '#888' };
        }
      }

      return {
        total: recentTasks.length,
        completed: totalCompleted,
        failed: totalFailed,
        unassigned,
        byRole: Object.entries(byRole)
          .sort((a, b) => b[1].total - a[1].total)
          .map(([slug, stats]) => ({
            slug,
            name: roleInfo[slug]?.name || slug,
            color: roleInfo[slug]?.color || '#888',
            ...stats,
          })),
      };
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

    // Unhealthy backend credentials for this team
    (async (): Promise<CredentialHealthItem[]> => {
      const credRows = await db.query.secrets.findMany({
        where: and(
          eq(secrets.teamId, activeTeamId),
          or(
            eq(secrets.healthStatus, 'revoked'),
            eq(secrets.healthStatus, 'degraded'),
          ),
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
        healthStatus: r.healthStatus as 'degraded' | 'revoked',
        consecutiveAuthFailures: r.consecutiveAuthFailures,
        lastFailureAt: r.lastFailureAt ? r.lastFailureAt.toISOString() : null,
        lastFailureMessage: r.lastFailureMessage ?? null,
        lastSuccessAt: r.lastSuccessAt ? r.lastSuccessAt.toISOString() : null,
        lastVerifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
      }));
    })().catch(() => [] as CredentialHealthItem[]),

    // Budget forecast
    getBudgetForecast(activeTeamId, scopedWsIds).catch(() => null as BudgetForecast | null),

    // Consumption (7d): tokens / cost / turns / tool calls per task, by role.
    // Shorter window than the 30d role block above — spend shifts with model and
    // prompt changes, so a month-long average hides the thing you'd act on.
    (async (): Promise<ConsumptionStats | null> => {
      const window = '7d';
      const windowStart = new Date(Date.now() - parseWindowMs(window));
      const rows = await fetchUsageRows({ workspaceIds: scopedWsIds, windowStart });
      if (rows.length === 0) return null;

      const stats = computeUsageStats(rows, 'role');
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
        groups: stats.groups.map(g => ({
          ...g,
          label: roleBySlug.get(g.key)?.name ?? (g.key === UNASSIGNED_ROLE ? 'No role' : g.key),
          color: roleBySlug.get(g.key)?.color ?? '#888',
        })),
      };
    })().catch(() => null),
  ]);

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
      taskTitle: s.taskTemplate?.title ?? '',
      missionTitle: s.missionTitle,
      isHeartbeat: !!s.isHeartbeat,
    }))
    .sort((a: ScheduleRow, b: ScheduleRow) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return (a.nextRunAt ?? '9999') < (b.nextRunAt ?? '9999') ? -1 : 1;
    });

  return (
    <HealthClient
      runners={runners}
      usageStats={usageStats}
      consumption={consumption ?? null}
      schedules={serializedSchedules}
      recentFailures={recentFailureRows ?? []}
      credentialHealth={credentialHealthRows ?? []}
      teamWorkspaces={(teamWorkspaceRows as any[]).map((w: any) => ({ id: w.id as string, name: w.name as string }))}
      wsFilter={wsFilter ?? null}
      budgetForecast={budgetForecast ?? null}
    />
  );
}
