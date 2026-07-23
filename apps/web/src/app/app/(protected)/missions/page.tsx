import { db } from '@buildd/core/db';
import { missions, teams, workspaceSkills, accounts, workers, workspaces } from '@buildd/core/db/schema';
import { inArray, desc, and, eq, sql, or, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds, resolveActiveTeamId } from '@/lib/team-access';
import { deriveMissionHealth, deriveHealth, healthToGroup, FILTER_TO_GROUPS } from '@/lib/mission-helpers';
import { computeMissionProgress } from '@buildd/core/mission-helpers';
import { isValidTaskId } from '@/lib/task-id';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { MissionGrid } from './MissionGrid';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';

export const dynamic = 'force-dynamic';

export default async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  const { workspace: wsFilter } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return (
      <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
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

  // Namespace this view to the active team (buildd-team cookie). Home stays
  // cross-team; the missions list shows only the active team's missions.
  const cookieStore = await cookies();
  const activeTeamId =
    (await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value)) ?? teamIds[0];
  const scopedTeamIds = [activeTeamId];

  // Query seat utilization across the active team's accounts
  const teamAccounts = await db.query.accounts.findMany({
    where: inArray(accounts.teamId, scopedTeamIds),
    columns: { id: true, maxConcurrentWorkers: true },
  });
  const maxSeats = teamAccounts.reduce((sum, a) => sum + a.maxConcurrentWorkers, 0);
  let activeSeats = 0;
  if (teamAccounts.length > 0) {
    const accountIds = teamAccounts.map(a => a.id);
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workers)
      .where(and(
        inArray(workers.accountId, accountIds),
        inArray(workers.status, [...LIVE_WORKER_STATUSES]),
      ));
    activeSeats = row?.count ?? 0;
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

  // Load active team's workspaces for the filter dropdown
  const teamWorkspaces = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.teamId, activeTeamId));

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

  // Missions filter: when workspace is selected, show missions anchored to that
  // workspace OR team-level missions (workspaceId IS NULL). Team-level missions
  // are never excluded — they belong to the team, not any one workspace.
  const missionsWhere = wsFilter
    ? and(
        eq(missions.teamId, activeTeamId),
        or(eq(missions.workspaceId, wsFilter), isNull(missions.workspaceId)),
      )
    : eq(missions.teamId, activeTeamId);

  const allMissions = await db.query.missions.findMany({
    where: missionsWhere,
    orderBy: [desc(missions.priority), desc(missions.createdAt)],
    limit: 50,
    columns: { id: true, title: true, description: true, status: true, teamId: true, workspaceId: true, orchestrationMode: true, costBudgetUsd: true, dependsOnMissionId: true, dependencyMetAt: true },
    with: {
      workspace: { columns: { id: true, name: true } },
      tasks: {
        columns: { id: true, title: true, status: true, result: true, updatedAt: true, kind: true, mode: true, creationSource: true },
        orderBy: (t: any, { desc }: any) => [desc(t.updatedAt)],
        limit: 20,
        with: {
          workers: {
            columns: { id: true, status: true, startedAt: true, turns: true, prUrl: true, mergedAt: true },
            limit: 5,
          },
        },
      },
      schedule: { columns: { nextRunAt: true, lastRunAt: true, cronExpression: true, lastDeferralReason: true, lastDeferredAt: true } },
    },
  });

  // Compute mission data
  const missionsList = allMissions.map((obj) => {
    const { totalTasks, completedTasks, progress, segments } = computeMissionProgress(obj.tasks || []);
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
    const lastDeferralReason = (obj.schedule as any)?.lastDeferralReason || null;
    const lastDeferredAt = (obj.schedule as any)?.lastDeferredAt ? String((obj.schedule as any).lastDeferredAt) : null;

    const health = deriveMissionHealth({
      status: obj.status,
      activeAgents,
      cronExpression: scheduleCron,
      lastRunAt,
      nextRunAt,
      orchestrationMode: obj.orchestrationMode,
    });

    const rawLatestId: string | undefined = (obj.tasks as any)[0]?.id;
    const latestTaskId = isValidTaskId(rawLatestId) ? rawLatestId : null;

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
      lastDeferralReason,
      lastDeferredAt,
      latestFinding: latestFinding
        ? {
            title: (latestFinding.result as any)?.summary?.slice(0, 120) || 'Finding',
            time: String(latestFinding.updatedAt),
          }
        : null,
      orchestrationMode: obj.orchestrationMode || null,
      workspaceId: obj.workspaceId || null,
      workspaceName: (obj.workspace as any)?.name || null,
      primaryPrUrl: (obj as any).primaryPrUrl || null,
      primaryPrNumber: (obj as any).primaryPrNumber || null,
      latestTaskId,
      costBudgetUsd: (obj as any).costBudgetUsd ?? null,
      spendUsd: null,
      segments,
      healthState: deriveHealth(obj, obj.tasks || []),
      inFlightTasks: (obj.tasks || []).flatMap(t => (t.workers || []).filter(w => LIVE_WORKER_STATUSES.includes(w.status as any)).map(w => ({ id: t.id, title: t.title, startedAt: w.startedAt ? String(w.startedAt) : null, turns: w.turns }))),
    };
  });

  const activeGroups = FILTER_TO_GROUPS.active ?? [];
  const activeCount = missionsList.filter(
    (m) => activeGroups.includes(healthToGroup(m.health, m.progress))
  ).length;

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        {/* Row 1: title + active count */}
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-xl font-semibold text-text-primary font-sans">Missions</h1>
          <span className="text-xs text-text-secondary font-light">
            {activeCount} active
          </span>
        </div>
        {/* Row 2 on mobile / right side on desktop: seats chip + workspace filter + new button */}
        <div className="flex items-center gap-2 flex-wrap">
          {maxSeats > 0 && (
            <span
              className={`text-[11px] font-mono px-2 py-0.5 rounded-full ${
                activeSeats >= maxSeats
                  ? 'bg-status-warning/15 text-status-warning'
                  : 'bg-[rgba(122,172,202,0.12)] text-status-info'
              }`}
              title={`${activeSeats} of ${maxSeats} concurrent worker seats in use`}
            >
              Seats: {activeSeats}/{maxSeats}
            </span>
          )}
          <WorkspaceFilter
            workspaces={teamWorkspaces}
            selectedId={wsFilter ?? null}
          />
          <Link
            href="/app/missions/new"
            className="px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors"
          >
            + New Mission
          </Link>
        </div>
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
