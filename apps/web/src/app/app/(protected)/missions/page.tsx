import { db } from '@buildd/core/db';
import { objectives, workspaceSkills } from '@buildd/core/db/schema';
import { inArray, desc, and, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { deriveMissionHealth, HEALTH_DISPLAY, timeAgo } from '@/lib/mission-helpers';

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

  const allObjectives = await db.query.objectives.findMany({
    where: inArray(objectives.teamId, teamIds),
    orderBy: [desc(objectives.priority), desc(objectives.createdAt)],
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
      schedule: { columns: { nextRunAt: true, lastRunAt: true } },
    },
  });

  // Compute mission data
  const missions = allObjectives.map((obj) => {
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

    const role = obj.defaultRoleSlug ? rolesMap.get(obj.defaultRoleSlug) : null;

    const health = deriveMissionHealth({
      status: obj.status,
      activeAgents,
      cronExpression: obj.cronExpression,
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
      lastRunAt,
      role: role ? { name: role.name, color: role.color } : null,
      latestFinding: latestFinding
        ? {
            title: (latestFinding.result as any)?.summary?.slice(0, 120) || 'Finding',
            time: latestFinding.updatedAt,
          }
        : null,
    };
  });

  const activeCount = missions.filter(
    (m) => m.health === 'active' || m.health === 'on-schedule'
  ).length;

  return (
    <div className="px-7 md:px-10 pt-5 md:pt-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
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

      {missions.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary mb-1">No missions yet.</p>
          <p className="text-xs text-text-muted">
            Create a mission to organize your agents around a goal.
          </p>
        </div>
      ) : (
        <div className={missions.length > 4 ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'space-y-3'}>
          {missions.map((mission) => (
            <MissionCard key={mission.id} mission={mission} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Unified Mission Card ── */
function MissionCard({ mission }: { mission: any }) {
  const healthDisplay = HEALTH_DISPLAY[mission.health as keyof typeof HEALTH_DISPLAY];

  return (
    <Link
      href={`/app/missions/${mission.id}`}
      className="card card-interactive block p-4 hover:bg-card-hover"
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          {mission.role && (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: mission.role.color }}
            />
          )}
          <span className="text-[17px] font-medium text-text-primary leading-tight truncate">
            {mission.title}
          </span>
          <span className={`health-pill ${healthDisplay.colorClass}`}>
            {healthDisplay.label}
          </span>
        </div>
        {mission.progress > 0 && (
          <span className="font-display text-2xl text-status-success shrink-0 tabular-nums">
            {mission.progress}%
          </span>
        )}
      </div>

      {mission.description && (
        <p className="text-[13px] text-text-secondary font-normal line-clamp-2 mb-3">
          {mission.description}
        </p>
      )}

      {/* Progress bar */}
      {mission.totalTasks > 0 && (
        <div className="h-[3px] rounded-full bg-[rgba(255,245,230,0.06)] mb-2.5 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${mission.progress}%`,
              background: 'linear-gradient(90deg, var(--status-success), #7ad4aa)',
            }}
          />
        </div>
      )}

      <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
        {mission.role && (
          <>
            <span>{mission.role.name}</span>
            <span className="mx-0.5">&middot;</span>
          </>
        )}
        {mission.totalTasks > 0 && (
          <span>
            {mission.completedTasks} of {mission.totalTasks} done
          </span>
        )}
        {mission.activeAgents > 0 && (
          <>
            <span className="mx-0.5">&middot;</span>
            <span className="text-status-success">
              {mission.activeAgents} agent{mission.activeAgents !== 1 ? 's' : ''} active
            </span>
          </>
        )}
        {mission.nextScanMins !== null && (
          <>
            <span className="mx-0.5">&middot;</span>
            <span>next run {mission.nextScanMins}m</span>
          </>
        )}
        {mission.latestFinding && (
          <>
            <span className="mx-0.5">&middot;</span>
            <span className="text-accent-text truncate max-w-[180px]">
              {mission.latestFinding.title}
            </span>
          </>
        )}
      </div>
    </Link>
  );
}
