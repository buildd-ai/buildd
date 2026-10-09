import { db } from '@buildd/core/db';
import { missions, accounts, workers, workspaces, teams } from '@buildd/core/db/schema';
import { inArray, and, eq, sql, or, isNull } from 'drizzle-orm';
import type { ReleaseFooterData } from '@/components/MissionReleaseFooter';
import { loadReleaseFooterData } from '@/lib/release-footer';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { NewWorkLink, SetUpChatNudge } from '@/components/chat/ChatEntry';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { summarizeMissionForCard, type MissionCardRow } from '@/lib/mission-card-view';
import { projectMissionDelivery } from '@/lib/delivery-projection';
import { MissionGrid, type PortfolioRow } from './MissionGrid';
import {
  COMPLETED_MISSIONS_PAGE_SIZE,
  buildActiveMissionsQueryArgs,
  buildCompletedMissionsQueryArgs,
  decodeCompletedCursor,
  paginateCompletedMissions,
} from '@/lib/missions-query';

export const dynamic = 'force-dynamic';

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

  // D6: release state is workspace-level — one footer per workspace, rendered
  // once on the list, never on each mission row.
  const uniqueWorkspaces = new Map<string, { id: string; name: string | null; gitConfig: unknown; releaseConfig: unknown }>();
  for (const m of allMissions) {
    const ws = m.workspace as { id: string; name: string; gitConfig: unknown; releaseConfig: unknown } | null | undefined;
    if (ws?.id && !uniqueWorkspaces.has(ws.id)) uniqueWorkspaces.set(ws.id, ws as any);
  }
  // Shared with mission detail's MissionReleaseSection (lib/release-footer.ts)
  // so the two surfaces cannot disagree about queue depth or deploy state.
  const releaseFooters: Record<string, ReleaseFooterData> = {};
  await Promise.all(
    Array.from(uniqueWorkspaces.values()).map(async (ws) => {
      releaseFooters[ws.id] = await loadReleaseFooterData({
        id: ws.id,
        name: ws.name,
        gitConfig: ws.gitConfig,
        releaseConfig: ws.releaseConfig,
      });
    }),
  );

  // One row per mission from the shared delivery projection — the same one
  // Home reads (lib/delivery-projection.ts), so a mission's chip, landed n/m
  // and next milestone read the same on both.
  const live = new Set<string>(LIVE_WORKER_STATUSES);
  const now = Date.now();
  const rows: PortfolioRow[] = allMissions.map((obj) => {
    const delivery = projectMissionDelivery({
      id: obj.id, title: obj.title, status: obj.status, href: `/app/missions/${obj.id}`,
      isHeld: obj.isHeld ?? false, integrationBranch: obj.integrationBranchEnabled === true,
      tasks: obj.tasks ?? [],
    }, missionHelpers);
    const tasks = (obj.tasks ?? []) as Array<{ updatedAt?: Date | string | null; workers?: Array<{ status: string }> }>;
    const lastAdvancedAt = Math.max(
      0,
      ...tasks.map(t => (t.updatedAt ? new Date(t.updatedAt).getTime() : 0)),
      obj.lastTaskStartedAt ? new Date(obj.lastTaskStartedAt).getTime() : 0,
    );
    const schedule = obj.schedule as { cronExpression?: string | null; taskTemplate?: { context?: { heartbeat?: boolean } } } | null;
    const recurring = !!schedule?.cronExpression && schedule.taskTemplate?.context?.heartbeat !== true && obj.status !== 'completed';
    return {
      // The client needs the mission's facts, not every task's projection.
      delivery: { ...delivery, tasks: [] },
      status: obj.status,
      workspaceId: obj.workspaceId ?? null,
      workspaceName: (obj.workspace as { name?: string } | null)?.name ?? null,
      priority: obj.priority ?? 0,
      liveAgents: tasks.reduce((n, t) => n + (t.workers ?? []).filter(w => live.has(w.status)).length, 0),
      lastAdvancedAt: lastAdvancedAt > 0 ? lastAdvancedAt : null,
      completedAt: obj.completedAt ? new Date(obj.completedAt).getTime() : null,
      nextScanMins: recurring ? summarizeMissionForCard(obj as MissionCardRow, { now }).nextScanMins : null,
    };
  });

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 pb-10 max-w-[1180px]">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="section-label hidden text-text-muted md:block">
            {team?.name ?? 'Team'}
          </div>
          {/* The mobile header already reads "Missions · Team"; show the h1 from md up only. */}
          <h1 data-testid="missions-headline" className="sr-only md:not-sr-only md:mt-1.5 font-mono text-[22px] font-semibold tracking-[-0.5px] text-text-primary md:text-[26px]">
            Missions
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <SetUpChatNudge />
          <NewWorkLink
            kind="mission"
            workspaceId={wsFilter ?? null}
            testId="new-mission-link"
            className="inline-flex min-h-11 items-center border-2 border-primary bg-primary px-3.5 font-mono text-[12.5px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover md:min-h-9"
          >
            + New mission
          </NewWorkLink>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary">No missions.</p>
        </div>
      ) : (
        <MissionGrid
          rows={rows}
          releaseFooters={releaseFooters}
          slots={{ live: activeSeats, max: maxSeats }}
          workspaces={teamWorkspaces}
          now={now}
        />
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
