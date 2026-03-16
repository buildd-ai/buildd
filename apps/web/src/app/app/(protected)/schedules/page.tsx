import { db } from '@buildd/core/db';
import { objectives, taskSchedules, workspaces } from '@buildd/core/db/schema';
import { eq, inArray, isNotNull, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import SchedulesUnified, { type UnifiedScheduleItem } from './SchedulesUnified';

export const dynamic = 'force-dynamic';

export default async function SchedulesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const [teamIds, wsIds] = await Promise.all([
    getUserTeamIds(user.id),
    getUserWorkspaceIds(user.id),
  ]);

  if (teamIds.length === 0 || wsIds.length === 0) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <h1 className="text-2xl font-bold text-text-primary mb-2">Schedules</h1>
        <p className="text-text-secondary">No workspaces found. Create a workspace to get started.</p>
      </div>
    );
  }

  // Fetch workspace name map
  const userWorkspaces = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, wsIds),
    columns: { id: true, name: true },
  });
  const wsNameMap = new Map(userWorkspaces.map(w => [w.id, w.name]));

  // Fetch all objectives with cron expressions (heartbeat + scheduled)
  const scheduledObjectives = await db.query.objectives.findMany({
    where: inArray(objectives.teamId, teamIds),
    columns: {
      id: true,
      title: true,
      cronExpression: true,
      isHeartbeat: true,
      status: true,
      workspaceId: true,
    },
    with: {
      schedule: {
        columns: {
          id: true,
          nextRunAt: true,
          lastRunAt: true,
          totalRuns: true,
          consecutiveFailures: true,
          enabled: true,
        },
      },
    },
    orderBy: [desc(objectives.createdAt)],
  });

  // Fetch all workspace-level task schedules (standalone, no objective wrapper)
  // Exclude schedules that are already linked to an objective (they appear via the objective)
  const objectiveScheduleIds = new Set(
    scheduledObjectives
      .map(o => o.schedule?.id)
      .filter(Boolean) as string[]
  );

  const standaloneSchedules = await db.query.taskSchedules.findMany({
    where: inArray(taskSchedules.workspaceId, wsIds),
    columns: {
      id: true,
      workspaceId: true,
      name: true,
      cronExpression: true,
      enabled: true,
      nextRunAt: true,
      lastRunAt: true,
      totalRuns: true,
      consecutiveFailures: true,
      pendingSuggestion: true,
    },
    orderBy: [desc(taskSchedules.createdAt)],
  });

  // Build unified list
  const items: UnifiedScheduleItem[] = [];

  // Objectives with cron (heartbeats and scheduled)
  for (const obj of scheduledObjectives) {
    if (!obj.cronExpression) continue;
    items.push({
      id: obj.id,
      name: obj.title,
      type: obj.isHeartbeat ? 'heartbeat' : 'cron-objective',
      workspaceId: obj.workspaceId,
      workspaceName: obj.workspaceId ? (wsNameMap.get(obj.workspaceId) ?? null) : null,
      cronExpression: obj.cronExpression,
      nextRunAt: obj.schedule?.nextRunAt?.toISOString() ?? null,
      lastRunAt: obj.schedule?.lastRunAt?.toISOString() ?? null,
      totalRuns: obj.schedule?.totalRuns ?? 0,
      consecutiveFailures: obj.schedule?.consecutiveFailures ?? 0,
      isEnabled: obj.status === 'active',
      href: `/app/objectives/${obj.id}`,
      apiType: 'objective',
      apiId: obj.id,
      apiWorkspaceId: null,
    });
  }

  // Standalone workspace schedules (not linked to an objective)
  for (const s of standaloneSchedules) {
    if (objectiveScheduleIds.has(s.id)) continue;
    items.push({
      id: s.id,
      name: s.name,
      type: 'workspace-schedule',
      workspaceId: s.workspaceId,
      workspaceName: wsNameMap.get(s.workspaceId) ?? null,
      cronExpression: s.cronExpression,
      nextRunAt: s.nextRunAt?.toISOString() ?? null,
      lastRunAt: s.lastRunAt?.toISOString() ?? null,
      totalRuns: s.totalRuns,
      consecutiveFailures: s.consecutiveFailures,
      isEnabled: s.enabled,
      href: `/app/workspaces/${s.workspaceId}/schedules`,
      apiType: 'taskSchedule',
      apiId: s.id,
      apiWorkspaceId: s.workspaceId,
      pendingSuggestion: s.pendingSuggestion as UnifiedScheduleItem['pendingSuggestion'],
    });
  }

  // Sort: enabled first, then by nextRunAt ascending (soonest first), then no-next-run at end
  items.sort((a, b) => {
    if (a.isEnabled !== b.isEnabled) return a.isEnabled ? -1 : 1;
    if (a.nextRunAt && b.nextRunAt) {
      return new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime();
    }
    if (a.nextRunAt) return -1;
    if (b.nextRunAt) return 1;
    return 0;
  });

  return <SchedulesUnified items={items} workspaces={userWorkspaces} />;
}
