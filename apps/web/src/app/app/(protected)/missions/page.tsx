import { db } from '@buildd/core/db';
import { missions, teams, workspaceSkills, accounts, workers, workspaces, initiatives, releases, tasks as tasksTable } from '@buildd/core/db/schema';
import { inArray, desc, and, eq, sql, or, isNull, isNotNull } from 'drizzle-orm';
import { detectArchetype } from '@buildd/core/release-archetype';
import type { ReleaseFooterData } from '@/components/MissionReleaseFooter';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds, resolveActiveTeamId } from '@/lib/team-access';
import { deriveMissionHealth, deriveHealth, healthToGroup, FILTER_TO_GROUPS } from '@/lib/mission-helpers';
import { computeMissionProgress, computeMissionSkyline } from '@buildd/core/mission-helpers';
import { isValidTaskId } from '@/lib/task-id';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { resolvePolicy } from '@/lib/merge-policy';
import { MissionGrid } from './MissionGrid';
import { countBlockedByPR, type BlockingTask } from '@/lib/initiative-pulse';
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
    orderBy: [desc(missions.priority), desc(missions.lastTaskStartedAt), desc(missions.updatedAt)],
    limit: 50,
    columns: { id: true, title: true, description: true, status: true, teamId: true, workspaceId: true, orchestrationMode: true, costBudgetUsd: true, dependsOnMissionId: true, dependencyMetAt: true, mergePolicy: true, startAt: true, isHeld: true, initiativeId: true, priority: true, goalCriteria: true, goalCriteriaState: true, lastTaskStartedAt: true, createdAt: true, updatedAt: true },
    with: {
      workspace: { columns: { id: true, name: true, gitConfig: true, releaseConfig: true } },
      initiative: { columns: { id: true, title: true } },
      tasks: {
        columns: { id: true, title: true, status: true, result: true, updatedAt: true, kind: true, mode: true, creationSource: true, category: true, parentTaskId: true, dependsOn: true, scheduleId: true, startAt: true, loopIteration: true },
        orderBy: (t: any, { desc }: any) => [desc(t.updatedAt)],
        with: {
          workers: {
            columns: { id: true, status: true, startedAt: true, completedAt: true, updatedAt: true, turns: true, prUrl: true, mergedAt: true, prNumber: true, prLifecycleStatus: true },
            limit: 5,
          },
        },
      },
      schedule: { columns: { id: true, nextRunAt: true, lastRunAt: true, cronExpression: true, lastDeferralReason: true, lastDeferredAt: true, maxConcurrentFromSchedule: true } },
    },
  });

  const POLICY_TIER_LABEL: Record<string, string> = {
    'auto-threshold': 'Auto',
    'agent-review': 'Agent Review',
    'human': 'Human Gate',
  };

  // Blocked-PR count per mission (LAYER 3 chip). The index spans every loaded
  // mission because `dependsOn` crosses mission boundaries; the counting rule
  // itself is shared with the Initiatives list (lib/initiative-pulse.ts) so the
  // two surfaces cannot disagree about what "blocked" means.
  const allMissionTaskMap = new Map<string, BlockingTask>();
  for (const m of allMissions) {
    for (const t of m.tasks || []) {
      allMissionTaskMap.set(t.id, t as unknown as BlockingTask);
    }
  }

  // Compute release footer data per unique workspace (gated: queue depth; continuous: last deploy state)
  const uniqueWorkspaces = new Map<string, { id: string; name: string | null; gitConfig: unknown; releaseConfig: unknown }>();
  for (const m of allMissions) {
    const ws = m.workspace as { id: string; name: string; gitConfig: unknown; releaseConfig: unknown } | null | undefined;
    if (ws?.id && !uniqueWorkspaces.has(ws.id)) uniqueWorkspaces.set(ws.id, ws as any);
  }

  const releaseFooterMap = new Map<string, ReleaseFooterData>();
  const gatedWsIds: string[] = [];
  const continuousWsIds: string[] = [];

  for (const [wsId, ws] of uniqueWorkspaces) {
    const archetype = detectArchetype({
      name: ws.name as string | null,
      releaseConfig: (ws.releaseConfig as any) ?? null,
      gitConfig: (ws.gitConfig as any) ?? null,
    });
    if (archetype === 'gated') gatedWsIds.push(wsId);
    else if (archetype === 'continuous') continuousWsIds.push(wsId);
  }

  if (gatedWsIds.length > 0) {
    await Promise.all(gatedWsIds.map(async (wsId) => {
      const [relRow] = await db
        .select({ maxHealthyAt: sql<string | null>`MAX(healthy_at)::text` })
        .from(releases)
        .where(and(eq(releases.workspaceId, wsId), eq(releases.state, 'healthy')));
      const hasRelease = relRow?.maxHealthyAt != null;

      const [queueRow] = await db
        .select({
          queueDepth: sql<number>`count(*)::int`,
          oldestMergedAt: sql<string | null>`min(${workers.mergedAt})::text`,
        })
        .from(workers)
        .innerJoin(tasksTable, eq(tasksTable.id, workers.taskId))
        .where(and(
          eq(tasksTable.workspaceId, wsId),
          isNotNull(workers.mergedAt),
          sql`${workers.mergedAt} > COALESCE(
            (SELECT MAX(healthy_at) FROM releases WHERE workspace_id = ${wsId}::uuid AND state = 'healthy'),
            '1970-01-01'::timestamptz
          )`,
        ));

      releaseFooterMap.set(wsId, {
        archetype: 'gated',
        queueDepth: queueRow?.queueDepth ?? 0,
        oldestMergedAt: queueRow?.oldestMergedAt ?? null,
        hasRelease,
      });
    }));
  }

  if (continuousWsIds.length > 0) {
    await Promise.all(continuousWsIds.map(async (wsId) => {
      const [lastRelease] = await db
        .select({
          state: releases.state,
          deployedAt: sql<string | null>`deployed_at::text`,
          healthyAt: sql<string | null>`healthy_at::text`,
        })
        .from(releases)
        .where(eq(releases.workspaceId, wsId))
        .orderBy(desc(releases.createdAt))
        .limit(1);

      releaseFooterMap.set(wsId, lastRelease
        ? {
            archetype: 'continuous',
            state: lastRelease.state,
            deployedAt: lastRelease.deployedAt ?? null,
            healthyAt: lastRelease.healthyAt ?? null,
          }
        : null,
      );
    }));
  }

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
    const rawDeferralReason = (obj.schedule as any)?.lastDeferralReason || null;
    const lastDeferredAt = (obj.schedule as any)?.lastDeferredAt ? String((obj.schedule as any).lastDeferredAt) : null;

    // Compute whether the per-schedule concurrent cap is still actually exceeded.
    // If not, clear the stale 'concurrent_cap' reason so the badge shows AUTO.
    let lastDeferralReason = rawDeferralReason;
    if (rawDeferralReason === 'concurrent_cap') {
      const schedId = (obj.schedule as any)?.id;
      const maxConcurrent: number = (obj.schedule as any)?.maxConcurrentFromSchedule ?? 1;
      const activeScheduleTasks = (obj.tasks || []).filter((t: any) =>
        t.scheduleId === schedId &&
        ['pending', 'assigned', 'in_progress'].includes(t.status)
      ).length;
      if (activeScheduleTasks < maxConcurrent) lastDeferralReason = null;
    }

    // Compute the earliest future startAt from user-scheduled pending tasks
    // (loopIteration === 0 means the task was explicitly scheduled, not a loop retry).
    const now = Date.now();
    let pendingUserScheduledAt: Date | null = null;
    for (const t of (obj.tasks || []) as any[]) {
      if (t.status !== 'pending') continue;
      if ((t.loopIteration ?? 0) !== 0) continue;
      if (!t.startAt) continue;
      const ts = new Date(t.startAt).getTime();
      if (ts > now && (pendingUserScheduledAt === null || ts < pendingUserScheduledAt.getTime())) {
        pendingUserScheduledAt = new Date(t.startAt);
      }
    }
    // A deliberately-scheduled pending task is not a seat-deferral.
    if (pendingUserScheduledAt) lastDeferralReason = null;

    const health = deriveMissionHealth({
      status: obj.status,
      activeAgents,
      cronExpression: scheduleCron,
      lastRunAt,
      nextRunAt,
      orchestrationMode: obj.orchestrationMode,
      isHeld: obj.isHeld ?? false,
      pendingUserScheduledAt,
    });

    const rawLatestId: string | undefined = (obj.tasks as any)[0]?.id;
    const latestTaskId = isValidTaskId(rawLatestId) ? rawLatestId : null;

    const workspaceForPolicy = obj.workspace as { id: string; name: string; gitConfig?: unknown } | null | undefined;
    const effectivePolicy = obj.workspaceId
      ? resolvePolicy(
          { gitConfig: (workspaceForPolicy as any)?.gitConfig ?? null },
          { mergePolicy: (obj as any).mergePolicy ?? null },
        )
      : null;
    const effectivePolicyLabel = effectivePolicy ? (POLICY_TIER_LABEL[effectivePolicy.tier] ?? effectivePolicy.tier) : null;

    // lastActivityAt: most recent task update or lastTaskStartedAt
    const taskTimes = (obj.tasks || []).map(t => t.updatedAt ? new Date(t.updatedAt as any).getTime() : 0);
    const lastTaskStartedMs = (obj as any).lastTaskStartedAt ? new Date((obj as any).lastTaskStartedAt).getTime() : 0;
    const lastActivityMs = Math.max(0, ...taskTimes, lastTaskStartedMs);
    const lastActivityAt = lastActivityMs > 0 ? new Date(lastActivityMs).toISOString() : null;

    // v1 approximation: updatedAt serves as mission close time for the review-tail
    // calculation. A dedicated closedAt column would be more precise but requires
    // a migration. The approximation is wrong only if the mission row is edited
    // (e.g. title rename) after workers finish but before the row is marked completed.
    const skyline = obj.status === 'completed'
      ? computeMissionSkyline(
          (obj.tasks || []).map((t: any) => ({ workers: t.workers || [] })),
          { missionCompletedAt: (obj as any).updatedAt },
        )
      : null;

    // When there's no schedule nextRunAt, use the earliest user-scheduled task
    // time so that sorted SCHEDULED cards still show meaningful timing.
    const effectiveNextRunAt = nextRunAt
      ? String(nextRunAt)
      : pendingUserScheduledAt
      ? pendingUserScheduledAt.toISOString()
      : null;
    const effectiveNextScanMins = nextScanMins ?? (pendingUserScheduledAt
      ? Math.max(0, Math.round((pendingUserScheduledAt.getTime() - Date.now()) / 60000))
      : null);


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
      nextScanMins: effectiveNextScanMins,
      nextRunAt: effectiveNextRunAt,
      startAt: obj.startAt ? String(obj.startAt) : null,
      lastRunAt: lastRunAt ? String(lastRunAt) : null,
      lastActivityAt,
      createdAt: (obj as any).createdAt ? new Date((obj as any).createdAt).toISOString() : null,
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
      isHeld: obj.isHeld ?? false,
      workspaceId: obj.workspaceId || null,
      workspaceName: (obj.workspace as any)?.name || null,
      primaryPrUrl: (obj as any).primaryPrUrl || null,
      primaryPrNumber: (obj as any).primaryPrNumber || null,
      latestTaskId,
      costBudgetUsd: (obj as any).costBudgetUsd ?? null,
      spendUsd: null,
      segments,
      effectivePolicyLabel,
      hasPolicyOverride: (obj as any).mergePolicy != null,
      awaitingMergePRCount: (obj.tasks || []).filter(t => {
        if (t.status !== 'completed') return false;
        const w = (t.workers as any[])?.[0];
        return w?.prUrl && !w?.mergedAt && w?.prLifecycleStatus !== 'closed';
      }).length,
      healthState: deriveHealth(obj, obj.tasks || []),
      inFlightTasks: (obj.tasks || []).flatMap(t => (t.workers || []).filter(w => LIVE_WORKER_STATUSES.includes(w.status as any)).map(w => ({ id: t.id, title: t.title, startedAt: w.startedAt ? String(w.startedAt) : null, turns: w.turns }))),
      blockedPRCount: countBlockedByPR(obj.tasks || [], allMissionTaskMap),
      initiativeId: obj.initiativeId || null,
      initiativeName: (obj.initiative as any)?.title || null,
      priority: obj.priority ?? 0,
      goalCriteriaCount: ((obj.goalCriteria as any[]) ?? []).length,
      goalCriteriaOverall: ((obj.goalCriteriaState as any)?.overall ?? null) as 'pass' | 'fail' | 'UNVERIFIED' | 'NOT_EVALUATED' | null,
      skyline,
      normalizationSlots: 0, // patched below after all missions are computed
      releaseFooter: obj.workspaceId ? (releaseFooterMap.get(obj.workspaceId) ?? null) : null,
    };
  });

  // Sort: active/in-flight missions first by lastActivityAt desc, then completed
  missionsList.sort((a, b) => {
    const aGroup = healthToGroup(a.health, a.progress);
    const bGroup = healthToGroup(b.health, b.progress);
    const aIsCompleted = aGroup === 'completed';
    const bIsCompleted = bGroup === 'completed';
    if (aIsCompleted !== bIsCompleted) return aIsCompleted ? 1 : -1;
    const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
    const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
    return bTime - aTime;
  });

  // Compute per-initiative normalization slots so sibling missions share a time axis.
  // For completed missions only (skyline is only shown there).
  const initNormSlots = new Map<string, number>();
  for (const m of missionsList) {
    if (!m.initiativeId || !m.skyline) continue;
    const prev = initNormSlots.get(m.initiativeId) ?? 0;
    if (m.skyline.totalSlots > prev) initNormSlots.set(m.initiativeId, m.skyline.totalSlots);
  }
  for (const m of missionsList) {
    if (m.initiativeId && m.skyline) {
      m.normalizationSlots = initNormSlots.get(m.initiativeId) ?? m.skyline.totalSlots;
    } else if (m.skyline) {
      m.normalizationSlots = m.skyline.totalSlots;
    }
  }

  const activeGroups = FILTER_TO_GROUPS.active ?? [];
  const activeCount = missionsList.filter(
    (m) => activeGroups.includes(healthToGroup(m.health, m.progress))
  ).length;

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        {/* Row 1: title + active count */}
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="hidden md:block text-xl font-semibold text-text-primary font-sans">Missions</h1>
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
          <span className="hidden md:block">
            <WorkspaceFilter
              workspaces={teamWorkspaces}
              selectedId={wsFilter ?? null}
            />
          </span>
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
