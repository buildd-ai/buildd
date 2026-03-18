import { db } from '@buildd/core/db';
import { objectives, workspaceSkills } from '@buildd/core/db/schema';
import { inArray, desc, and, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { classifyMission, timeAgo } from '@/lib/mission-helpers';

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
    const type = classifyMission(obj);
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

    // For watch missions: count "new signals" (completed tasks in last 24h)
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const newSignals = obj.tasks?.filter(
      (t: any) => t.status === 'completed' && new Date(t.updatedAt).getTime() > dayAgo
    ).length || 0;

    const nextRunAt = (obj.schedule as any)?.nextRunAt;
    const lastRunAt = (obj.schedule as any)?.lastRunAt;
    const nextScanMins = nextRunAt
      ? Math.max(0, Math.round((new Date(nextRunAt).getTime() - Date.now()) / 60000))
      : null;

    const role = obj.defaultRoleSlug ? rolesMap.get(obj.defaultRoleSlug) : null;

    return {
      id: obj.id,
      title: obj.title,
      description: obj.description,
      status: obj.status,
      type,
      totalTasks,
      completedTasks,
      progress,
      activeAgents,
      newSignals,
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
    (m) => m.status === 'active' && (m.activeAgents > 0 || m.type === 'watch')
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
            Missions are goals you assign to your agents — build features, watch for signals, or produce findings.
          </p>
        </div>
      ) : (
        <div className={missions.length > 4 ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'space-y-3'}>
          {missions.map((mission) => {
            if (mission.type === 'build') return <BuildCard key={mission.id} mission={mission} />;
            if (mission.type === 'watch') return <WatchCard key={mission.id} mission={mission} />;
            return <BriefCard key={mission.id} mission={mission} />;
          })}
        </div>
      )}
    </div>
  );
}

/* ── Build Card ── */
function BuildCard({ mission }: { mission: any }) {
  return (
    <Link
      href={`/app/missions/${mission.id}`}
      className="card card-interactive mission-build block p-4 hover:bg-card-hover"
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="type-label type-label-build">BUILD</span>
          <span className="text-[17px] font-medium text-text-primary leading-tight truncate">
            {mission.title}
          </span>
        </div>
        <span className="font-display text-2xl text-status-success shrink-0 tabular-nums">
          {mission.progress}%
        </span>
      </div>

      {mission.description && (
        <p className="text-[13px] text-text-secondary font-normal line-clamp-2 mb-3">
          {mission.description}
        </p>
      )}

      {/* Progress bar */}
      <div className="h-[3px] rounded-full bg-[rgba(255,245,230,0.06)] mb-2.5 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${mission.progress}%`,
            background: 'linear-gradient(90deg, var(--status-success), #7ad4aa)',
          }}
        />
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
        {mission.role && (
          <>
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: mission.role.color }}
            />
            <span>{mission.role.name}</span>
            <span className="mx-0.5">&middot;</span>
          </>
        )}
        <span>
          {mission.completedTasks} of {mission.totalTasks} done
        </span>
        {mission.activeAgents > 0 && (
          <>
            <span className="mx-0.5">&middot;</span>
            <span className="text-status-success">
              {mission.activeAgents} agent{mission.activeAgents !== 1 ? 's' : ''} active
            </span>
          </>
        )}
        {mission.status === 'paused' && (
          <>
            <span className="mx-0.5">&middot;</span>
            <span className="text-status-warning">paused</span>
          </>
        )}
      </div>
    </Link>
  );
}

/* ── Watch Card ── */
function WatchCard({ mission }: { mission: any }) {
  return (
    <Link
      href={`/app/missions/${mission.id}`}
      className="card card-interactive mission-watch block p-4 hover:bg-card-hover"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="type-label type-label-watch">WATCH</span>
            <span className="text-[17px] font-medium text-text-primary leading-tight truncate">
              {mission.title}
            </span>
          </div>
          {mission.description && (
            <p className="text-[13px] text-text-secondary font-normal line-clamp-2 mb-2.5">
              {mission.description}
            </p>
          )}
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
            {mission.role && (
              <>
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: mission.role.color }}
                />
                <span>{mission.role.name}</span>
                {(mission.newSignals > 0 || mission.nextScanMins !== null) && (
                  <span className="mx-0.5">&middot;</span>
                )}
              </>
            )}
            {mission.newSignals > 0 && (
              <span>{mission.newSignals} new signal{mission.newSignals !== 1 ? 's' : ''}</span>
            )}
            {mission.nextScanMins !== null && (
              <>
                {mission.newSignals > 0 && <span className="mx-0.5">&middot;</span>}
                <span>next scan {mission.nextScanMins}m</span>
              </>
            )}
            {mission.status === 'paused' && (
              <>
                <span className="mx-0.5">&middot;</span>
                <span className="text-status-warning">paused</span>
              </>
            )}
          </div>
        </div>

        {/* Flagged badge */}
        {mission.newSignals > 0 && (
          <div className="flex items-center gap-1.5 shrink-0 mt-1">
            <span className="w-1.5 h-1.5 rounded-full bg-status-warning" />
            <span className="text-[11px] font-medium text-status-warning tracking-wide">
              {mission.newSignals} FLAGGED
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}

/* ── Brief/Finding Card ── */
function BriefCard({ mission }: { mission: any }) {
  const finding = mission.latestFinding;

  return (
    <Link
      href={`/app/missions/${mission.id}`}
      className="block p-4 rounded-[14px] bg-card-finding border border-border-strong border-l-2 border-l-accent-text hover:bg-card-hover transition-colors"
    >
      {finding ? (
        <>
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono text-[10px] font-medium text-accent-text tracking-wide">
              NEW FINDING
            </span>
            <span className="text-[11px] text-text-muted">{timeAgo(finding.time)}</span>
          </div>
          <p className="text-[16px] font-medium text-text-primary leading-snug mb-1">
            {finding.title}
          </p>
          <div className="flex items-center gap-1.5 text-[12px] text-text-secondary font-light">
            <span>{mission.title}</span>
            {mission.role && (
              <>
                <span className="mx-0.5">&middot;</span>
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0 inline-block"
                  style={{ backgroundColor: mission.role.color }}
                />
                <span>{mission.role.name}</span>
              </>
            )}
            {mission.nextScanMins !== null && (
              <>
                <span className="mx-0.5">&middot;</span>
                <span className="text-text-muted">next run {mission.nextScanMins}m</span>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-1">
            <span className="type-label type-label-brief">BRIEF</span>
            <span className="text-[17px] font-medium text-text-primary leading-tight truncate">
              {mission.title}
            </span>
          </div>
          {mission.description && (
            <p className="text-[13px] text-text-secondary font-normal line-clamp-2 mb-2">
              {mission.description}
            </p>
          )}
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
            {mission.role && (
              <>
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: mission.role.color }}
                />
                <span>{mission.role.name}</span>
              </>
            )}
            {mission.totalTasks > 0 && (
              <>
                {mission.role && <span className="mx-0.5">&middot;</span>}
                <span>{mission.completedTasks} of {mission.totalTasks} runs</span>
              </>
            )}
            {mission.nextScanMins !== null && (
              <>
                <span className="mx-0.5">&middot;</span>
                <span>next run {mission.nextScanMins}m</span>
              </>
            )}
            {mission.status === 'paused' && (
              <>
                <span className="mx-0.5">&middot;</span>
                <span className="text-status-warning">paused</span>
              </>
            )}
          </div>
        </>
      )}
    </Link>
  );
}
