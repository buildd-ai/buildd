import { db } from '@buildd/core/db';
import { watchedProjects, watcherEvents, workspaces, tasks, workspaceSkills, taskSchedules, missions } from '@buildd/core/db/schema';
import { and, eq, inArray, desc, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getTeamWorkspaceIds, resolveActiveTeamId } from '@/lib/team-access';
import { getRunnerHeartbeats, type RunnerHeartbeat } from '@/lib/runner-heartbeats';
import { HealthClient } from './HealthClient';

export const dynamic = 'force-dynamic';

export interface WatchedProjectRow {
  id: string;
  workspaceId: string;
  workspaceName: string;
  repo: string;
  enabled: boolean;
  inFlightWindowMin: number;
  roleSlug: string;
  pushoverApp: 'tasks' | 'alerts';
  releasePrFilter: { base?: string; label?: string; titlePrefix?: string };
  notes: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  recentEvents: { kind: string; firedAt: string; taskId: string | null }[];
}

export interface WorkspaceOption {
  id: string;
  name: string;
}

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
}

export interface UsageStats {
  total: number;
  completed: number;
  failed: number;
  unassigned: number;
  byRole: { slug: string; name: string; color: string; completed: number; failed: number; total: number }[];
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
        <h1 className="text-2xl font-bold mb-2">Project Health</h1>
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
        <h1 className="text-2xl font-bold mb-2">Project Health</h1>
        <p className="text-sm text-text-tertiary">No workspaces yet.</p>
      </div>
    );
  }

  // Scope watched projects and usage to workspace filter when set
  const scopedWsIds = wsFilter && teamWorkspaceIds.includes(wsFilter)
    ? [wsFilter]
    : teamWorkspaceIds;

  // Parallel fetches: watched projects, runners, usage, schedules
  const [rows, runners, usageStats, scheduleRows] = await Promise.all([
    // Watched projects
    db
      .select()
      .from(watchedProjects)
      .where(inArray(watchedProjects.workspaceId, scopedWsIds))
      .orderBy(desc(watchedProjects.createdAt)),

    // Runner heartbeats relevant to the scoped workspaces
    getRunnerHeartbeats(activeTeamId, scopedWsIds)
      .catch(() => [] as RunnerHeartbeat[]),

    // Usage stats (last 30 days)
    (async (): Promise<UsageStats | null> => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentTasks = await db.query.tasks.findMany({
        where: and(
          inArray(tasks.workspaceId, scopedWsIds),
          sql`${tasks.createdAt} >= ${thirtyDaysAgo}`,
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
      return (schedules as any[]).map((s: any) => ({ ...s, missionTitle: missionBySchedule.get(s.id) ?? null }));
    })().catch(() => [] as any[]),
  ]);

  // Attach recent events to watched project rows
  const projectIds = (rows as any[]).map((r: any) => r.id as string);
  const events = projectIds.length
    ? await db
        .select()
        .from(watcherEvents)
        .where(inArray(watcherEvents.projectId, projectIds))
        .orderBy(desc(watcherEvents.firedAt))
        .limit(50)
    : [];
  const eventsByProject = new Map<string, { kind: string; firedAt: string; taskId: string | null }[]>();
  for (const e of events) {
    const list = eventsByProject.get(e.projectId) ?? [];
    if (list.length < 5) {
      list.push({ kind: e.kind, firedAt: e.firedAt.toISOString(), taskId: e.taskId });
      eventsByProject.set(e.projectId, list);
    }
  }

  const wsById = new Map((teamWorkspaceRows as any[]).map((w: any) => [w.id as string, w.name as string] as const));

  const serialized: WatchedProjectRow[] = (rows as any[]).map((r: any) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    workspaceName: wsById.get(r.workspaceId) ?? '(unknown)',
    repo: r.repo,
    enabled: r.enabled,
    inFlightWindowMin: r.inFlightWindowMin,
    roleSlug: r.roleSlug,
    pushoverApp: r.pushoverApp,
    releasePrFilter: r.releasePrFilter ?? {},
    notes: r.notes,
    lastCheckedAt: r.lastCheckedAt ? r.lastCheckedAt.toISOString() : null,
    lastError: r.lastError,
    recentEvents: eventsByProject.get(r.id) ?? [],
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
      taskTitle: s.taskTemplate?.title ?? '',
      missionTitle: s.missionTitle,
    }))
    .sort((a: ScheduleRow, b: ScheduleRow) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return (a.nextRunAt ?? '9999') < (b.nextRunAt ?? '9999') ? -1 : 1;
    });

  const workspaceOptions: WorkspaceOption[] = (teamWorkspaceRows as any[]).map((w: any) => ({
    id: w.id as string,
    name: w.name as string,
  }));

  return (
    <HealthClient
      initialRows={serialized}
      workspaces={workspaceOptions}
      runners={runners}
      usageStats={usageStats}
      schedules={serializedSchedules}
      teamWorkspaces={(teamWorkspaceRows as any[]).map((w: any) => ({ id: w.id as string, name: w.name as string }))}
      wsFilter={wsFilter ?? null}
    />
  );
}
