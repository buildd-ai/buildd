import { db } from '@buildd/core/db';
import { missions, teams, workspaceSkills } from '@buildd/core/db/schema';
import { inArray, desc, and, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { deriveMissionHealth } from '@/lib/mission-helpers';
import { MissionGrid } from './MissionGrid';

export const dynamic = 'force-dynamic';

export default async function MissionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return (
      <div className="px-7 md:px-10 pt-5 md:pt-8">
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="text-xl font-semibold text-text-primary">Missions</h1>
          <span className="text-xs text-text-secondary font-light">0 active</span>
        </div>
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary mb-1">No team found.</p>
          <p className="text-xs text-text-muted">Create a workspace to get started.</p>
        </div>
      </div>
    );
  }

  // Build team name map for display (only when user has multiple teams)
  const teamNameMap = new Map<string, string>();
  if (teamIds.length > 1) {
    const teamRows = await db.query.teams.findMany({
      where: inArray(teams.id, teamIds),
      columns: { id: true, name: true, slug: true },
    });
    teamRows.forEach(t => teamNameMap.set(t.id, t.slug.startsWith('personal-') ? 'personal' : t.name));
  }

  // Query roles for display
  const wsIds = await getUserWorkspaceIds(user.id);
  const rolesMap = new Map<string, { name: string; color: string }>();
  if (wsIds.length > 0) {
    const roles = await db.query.workspaceSkills.findMany({
      where: and(
        inArray(workspaceSkills.workspaceId, wsIds),
        eq(workspaceSkills.enabled, true),
      ),
      columns: { slug: true, name: true, color: true },
    });
    roles.forEach((r) => rolesMap.set(r.slug, { name: r.name, color: r.color }));
  }

  const allMissions = await db.query.missions.findMany({
    where: inArray(missions.teamId, teamIds),
    orderBy: [desc(missions.priority), desc(missions.createdAt)],
    limit: 50,
    with: {
      workspace: { columns: { id: true, name: true } },
      tasks: {
        columns: { id: true, status: true, result: true, updatedAt: true },
        orderBy: (t: any, { desc }: any) => [desc(t.updatedAt)],
        limit: 20,
        with: {
          workers: {
            columns: { id: true, status: true },
            limit: 5,
          },
        },
      },
      schedule: { columns: { nextRunAt: true, lastRunAt: true, cronExpression: true } },
    },
  });

  // Compute mission data
  const missionsList = allMissions.map((obj) => {
    const totalTasks = obj.tasks?.length || 0;
    const completedTasks = obj.tasks?.filter((t: any) => t.status === 'completed').length || 0;
    const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const activeAgents = obj.tasks
      ?.flatMap((t: any) => t.workers || [])
      .filter((w: any) => w.status === 'running').length || 0;

    // Latest finding — most recent task with a result that has structuredOutput or summary
    const latestFinding = obj.tasks?.find(
      (t: any) => t.status === 'completed' && t.result && ((t.result as any).structuredOutput || (t.result as any).summary)
    );

    const nextRunAt = (obj.schedule as any)?.nextRunAt;
    const lastRunAt = (obj.schedule as any)?.lastRunAt;
    const nextScanMins = nextRunAt
      ? Math.max(0, Math.round((new Date(nextRunAt).getTime() - Date.now()) / 60000))
      : null;

    const scheduleCron = (obj.schedule as any)?.cronExpression || null;

    const health = deriveMissionHealth({
      status: obj.status,
      activeAgents,
      cronExpression: scheduleCron,
      lastRunAt,
      nextRunAt,
    });

    return {
      id: obj.id,
      title: obj.title,
      description: obj.description,
      status: obj.status,
      health,
      totalTasks,
      completedTasks,
      progress,
      activeAgents,
      nextScanMins,
      nextRunAt: nextRunAt ? String(nextRunAt) : null,
      lastRunAt: lastRunAt ? String(lastRunAt) : null,
      teamName: teamNameMap.get(obj.teamId) || null,
      role: null as { name: string; color: string } | null,
      latestFinding: latestFinding
        ? {
            title: (latestFinding.result as any)?.summary?.slice(0, 120) || 'Finding',
            time: String(latestFinding.updatedAt),
          }
        : null,
    };
  });

  const activeCount = missionsList.filter(
    (m) => m.health === 'active' || m.health === 'on-schedule'
  ).length;

  return (
    <div className="px-7 md:px-10 pt-5 md:pt-8 max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold text-text-primary font-sans">Missions</h1>
          <span className="text-xs text-text-secondary font-light">
            {activeCount} active
          </span>
        </div>
        <Link
          href="/app/missions/new"
          className="px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors"
        >
          + New Mission
        </Link>
      </div>

      {missionsList.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary mb-1">No missions yet.</p>
          <p className="text-xs text-text-muted">
            Create a mission to organize your agents around a goal.
          </p>
        </div>
      ) : (
        <MissionGrid missions={missionsList} />
      )}
    </div>
  );
}
