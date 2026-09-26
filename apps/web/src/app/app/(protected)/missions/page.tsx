import { db } from '@buildd/core/db';
import { missions, accounts, workers, workspaces, teams } from '@buildd/core/db/schema';
import { inArray, and, eq, sql, or, isNull } from 'drizzle-orm';
import type { ReleaseFooterData } from '@/components/MissionReleaseFooter';
import { loadReleaseFooterData } from '@/lib/release-footer';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { computeMissionFlightStrip, type MissionFlightStripData } from '@buildd/core/mission-helpers';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import {
  buildMissionCardView,
  countActiveMissions,
  summarizeMissionForCard,
  type BlockingTask,
  type MissionCardRow,
} from '@/lib/mission-card-view';
import { MissionGrid, type MissionItem } from './MissionGrid';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';
import {
  COMPLETED_MISSIONS_PAGE_SIZE,
  adaptFlightStripInputs,
  buildActiveMissionsQueryArgs,
  buildCompletedMissionsQueryArgs,
  decodeCompletedCursor,
  paginateCompletedMissions,
} from '@/lib/missions-query';
import { loadHumanSteeringMarksByMission } from '@/lib/mission-steering-notes';
import { buildMissionListCard, missionsHeadline, type ListMissionRow } from '@/lib/mission-list-card';
import { loadWorkerProgress } from '@/lib/worker-progress';
import { loadTeamRoleColors } from '@/lib/role-colors';
import { SlotMeter } from '@/components/fleet/SlotMeter';

export const dynamic = 'force-dynamic';

const GROUP_SORT_COMPLETED_LAST = (g: string) => (g === 'completed' ? 1 : 0);

export default async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; completedCursor?: string }>;
}) {
  const { workspace: wsFilter, completedCursor: completedCursorParam } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return (
      <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="hidden md:block text-xl font-semibold text-text-primary">Missions</h1>
          <span className="text-xs text-text-secondary font-light">0 active</span>
        </div>
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary mb-1">No team found.</p>
          <p className="text-xs text-text-muted"><Link href="/app/teams/new" className="text-primary hover:underline">Create a team</Link> to plan missions.</p>
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

  // Missions filter: when workspace is selected, show missions anchored to that
  // workspace OR team-level missions (workspaceId IS NULL). Team-level missions
  // are never excluded — they belong to the team, not any one workspace.
  const missionsWhere = wsFilter
    ? and(
        eq(missions.teamId, activeTeamId),
        or(eq(missions.workspaceId, wsFilter), isNull(missions.workspaceId)),
      )
    : eq(missions.teamId, activeTeamId);

  // Rule P-4: the completed portion is bounded + keyset-paginated; the
  // active/scheduled portion stays unbounded (Rule P-3 already governs it via
  // workspace maxConcurrentTasks). Rule P-2: the completed query's `with`
  // shape omits roleSlug/exitCause by construction — see missions-query.ts.
  const completedCursor = decodeCompletedCursor(completedCursorParam);

  // Everything below needs only `activeTeamId` and the URL filter, all of
  // which are already resolved — so none of these depend on each other. The
  // one dependent chain (accounts -> live-seat count) stays inside its entry.
  const [
    seats,
    teamWorkspaces,
    activeRows,
    completedRowsPage,
    roleColors,
    teamRows,
  ] = await Promise.all([
    // Seat utilization across the active team's accounts. The live-seat count
    // needs the account ids, so it genuinely follows the accounts read.
    (async () => {
      const teamAccounts = await db.query.accounts.findMany({
        where: inArray(accounts.teamId, scopedTeamIds),
        columns: { id: true, maxConcurrentWorkers: true },
      });
      const max = teamAccounts.reduce((sum, a) => sum + a.maxConcurrentWorkers, 0);
      if (teamAccounts.length === 0) return { maxSeats: max, activeSeats: 0 };
      const accountIds = teamAccounts.map(a => a.id);
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(workers)
        .where(and(
          inArray(workers.accountId, accountIds),
          inArray(workers.status, [...LIVE_WORKER_STATUSES]),
        ));
      return { maxSeats: max, activeSeats: row?.count ?? 0 };
    })(),
    // Active team's workspaces for the filter dropdown
    db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.teamId, activeTeamId)),
    db.query.missions.findMany(buildActiveMissionsQueryArgs(missionsWhere) as any),
    db.query.missions.findMany(buildCompletedMissionsQueryArgs(missionsWhere, completedCursor) as any),
    // Role colours for the live-agent dots — read from the roles, never hardcoded.
    loadTeamRoleColors(activeTeamId),
    // The header's "Missions · <team>" label.
    db.select({ name: teams.name }).from(teams).where(eq(teams.id, activeTeamId)).limit(1),
  ]);
  const team = teamRows[0] ?? null;

  const { maxSeats, activeSeats } = seats;
  const { items: completedRows, nextCursor: nextCompletedCursor } = paginateCompletedMissions(
    completedRowsPage as unknown as Array<{ completedAt: Date | string | null; id: string }>,
    COMPLETED_MISSIONS_PAGE_SIZE,
  ) as unknown as { items: typeof completedRowsPage; nextCursor: string | null };

  const allMissions = [...activeRows, ...completedRows] as any[];

  // Blocked-PR index spans every loaded mission because `dependsOn` crosses
  // mission boundaries; the rule itself is shared with the Initiatives list
  // (`blockedByPRTaskIds`) so the two surfaces cannot disagree.
  const allMissionTaskMap = new Map<string, BlockingTask>();
  for (const m of allMissions) {
    for (const t of m.tasks || []) allMissionTaskMap.set(t.id, t as BlockingTask);
  }

  // D6: release state is workspace-level — one footer per workspace, rendered
  // once on the list, never on each mission card.
  const uniqueWorkspaces = new Map<string, { id: string; name: string | null; gitConfig: unknown; releaseConfig: unknown }>();
  for (const m of allMissions) {
    const ws = m.workspace as { id: string; name: string; gitConfig: unknown; releaseConfig: unknown } | null | undefined;
    if (ws?.id && !uniqueWorkspaces.has(ws.id)) uniqueWorkspaces.set(ws.id, ws as any);
  }

  // These two read from the mission rows above and from nothing each other
  // produces, so they are one wait rather than two. The release footers are
  // themselves 3 deep per workspace.
  const releaseFooters: Record<string, ReleaseFooterData> = {};
  // The running cells fill to each live worker's last reported progress.
  const liveWorkerIds = (activeRows as any[]).flatMap(m => (m.tasks || []).flatMap((t: any) =>
    (t.workers || []).filter((w: any) => (LIVE_WORKER_STATUSES as readonly string[]).includes(w.status)).map((w: any) => w.id as string)));
  const [steeringMarksByMission, progressByWorker] = await Promise.all([
    // Rule A-1/A-2: human steering marks (mission_notes, authorType='user') are
    // one batched query across the whole active set, not one per mission.
    loadHumanSteeringMarksByMission(activeRows.map((m: any) => m.id)),
    loadWorkerProgress(liveWorkerIds),
    // Shared with mission detail's MissionReleaseSection (lib/release-footer.ts)
    // so the two surfaces cannot disagree about queue depth or deploy state.
    Promise.all(
      Array.from(uniqueWorkspaces.values()).map(async (ws) => {
        releaseFooters[ws.id] = await loadReleaseFooterData({
          id: ws.id,
          name: ws.name,
          gitConfig: ws.gitConfig,
          releaseConfig: ws.releaseConfig,
        });
      }),
    ),
  ]);

  // Rule A-1/A-2: live flight-strip compute for every non-completed mission.
  // On a card it is reachable only from ⤢ (FlightDetailSheet, D4); completed
  // cards are compact and draw no strip (D7).
  const flightStripByMission = new Map<string, MissionFlightStripData | null>();
  for (const obj of activeRows as any[]) {
    const { tasks: flightTasks, workers: flightWorkers } = adaptFlightStripInputs(obj.tasks || []);
    flightStripByMission.set(
      obj.id,
      computeMissionFlightStrip(flightTasks, flightWorkers, {
        missionCompletedAt: obj.completedAt ?? null,
        steeringEvents: steeringMarksByMission.get(obj.id),
      }),
    );
  }

  // One model per card — the same builder Home uses (lib/mission-card-view.ts),
  // so a mission's chip, sentence, pulse and group read the same on both.
  const now = Date.now();
  const missionsList: MissionItem[] = allMissions.map((obj) => {
    const row = obj as MissionCardRow;
    const summary = summarizeMissionForCard(row, { now });
    const view = buildMissionCardView(row, {
      from: 'missions',
      now,
      summary,
      taskIndex: allMissionTaskMap,
      flightStrip: flightStripByMission.get(obj.id) ?? null,
    });

    // lastActivityAt: most recent task update or lastTaskStartedAt
    const taskTimes = (obj.tasks || []).map((t: any) => t.updatedAt ? new Date(t.updatedAt as any).getTime() : 0);
    const lastTaskStartedMs = obj.lastTaskStartedAt ? new Date(obj.lastTaskStartedAt).getTime() : 0;
    const lastActivityMs = Math.max(0, ...taskTimes, lastTaskStartedMs);

    return {
      view,
      list: buildMissionListCard(obj as ListMissionRow, view, summary, { now, roleColors, progressByWorker }),
      workspaceId: obj.workspaceId || null,
      workspaceName: (obj.workspace as any)?.name || null,
      isHeld: obj.isHeld ?? false,
      nextScanMins: summary.nextScanMins,
      lastActivityAt: lastActivityMs > 0 ? new Date(lastActivityMs).toISOString() : null,
      lastRunAt: (obj.schedule as any)?.lastRunAt ? String((obj.schedule as any).lastRunAt) : null,
    };
  });

  // Sort: unfinished missions first by lastActivityAt desc, then completed.
  missionsList.sort((a, b) => {
    const byGroup = GROUP_SORT_COMPLETED_LAST(a.view.group) - GROUP_SORT_COMPLETED_LAST(b.view.group);
    if (byGroup !== 0) return byGroup;
    const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
    const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
    return bTime - aTime;
  });

  // D8: the header counts with the cards' own grouping (healthToGroup), so a
  // mission waiting on you — a live worker — counts as active here too.
  const activeCount = countActiveMissions(missionsList.map(m => m.view.group));
  const runningMissions = missionsList.filter(m => m.list.kind === 'active');
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const headline = missionsHeadline({
    running: runningMissions.length,
    liveAgents: runningMissions.reduce((n, m) => n + m.list.live.count, 0),
    shippedToday: missionsList.filter(m => m.view.completedAt && new Date(m.view.completedAt).getTime() >= dayStart.getTime()).length,
  });

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 pb-10 max-w-[1180px]">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="section-label hidden text-text-muted md:block">
            Missions{team?.name ? ` · ${team.name}` : ''}
          </div>
          <h1 data-testid="missions-headline" className="mt-1.5 font-mono text-[22px] font-semibold tracking-[-0.5px] text-text-primary md:text-[26px]">
            {headline}
          </h1>
          <span data-testid="missions-active-count" className="sr-only">{activeCount} active</span>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {maxSeats > 0 && (
            <span
              data-testid="missions-slots"
              className="flex min-h-9 items-center gap-2 border border-border-default px-2.5 font-mono text-[12px] text-text-secondary"
              title={`${activeSeats} of ${maxSeats} concurrent worker slots in use`}
            >
              <SlotMeter live={activeSeats} max={maxSeats} />
              {activeSeats}/{maxSeats} slots
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
            data-testid="new-mission-link"
            className="inline-flex min-h-11 items-center border-2 border-primary bg-primary px-3.5 font-mono text-[12.5px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover md:min-h-9"
          >
            + New mission
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
        <MissionGrid missions={missionsList} releaseFooters={releaseFooters} slots={maxSeats > 0 ? { live: activeSeats, max: maxSeats } : null} />
      )}

      {/* Rule P-4: the completed portion is one bounded page; this is the
          escape hatch when a workspace has more than that. Replaces the
          visible completed page rather than appending — keeps the query
          layer a plain keyset page instead of client-side accumulation
          state, which nothing else on this list needs yet. */}
      {nextCompletedCursor && (
        <div className="mt-4 text-center">
          <Link
            href={`/app/missions?${new URLSearchParams({ ...(wsFilter ? { workspace: wsFilter } : {}), completedCursor: nextCompletedCursor }).toString()}`}
            className="text-[11px] text-text-muted hover:text-text-secondary font-mono"
          >
            Load older completed missions ↓
          </Link>
        </div>
      )}
    </div>
  );
}
