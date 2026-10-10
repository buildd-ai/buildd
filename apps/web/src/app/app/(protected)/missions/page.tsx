import { db } from '@buildd/core/db';
import { missions, accounts, workers } from '@buildd/core/db/schema';
import { inArray, and, eq, sql, or, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { NewWorkLink } from '@/components/chat/ChatEntry';
import { taskEstimatesEnabled } from '@buildd/core/task-estimate-source';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { summarizeMissionForCard, type MissionCardRow } from '@/lib/mission-card-view';
import { projectMissionDelivery } from '@/lib/delivery-projection';
import { taskRowsStripProjection } from '@/lib/mission-strip-order';
import { MissionGrid, type PortfolioRow } from './MissionGrid';
import { loadMissionVerdicts } from '@buildd/core/mission-verdicts';
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
        <h1 className="sr-only md:not-sr-only md:mb-4 text-heading font-semibold text-text-primary">Missions</h1>
        <p className="text-body text-text-secondary">
          No team found. <Link href="/app/teams/new" className="text-text-primary underline underline-offset-4">Create a team</Link> to plan missions.
        </p>
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
    activeRows,
    completedRowsPage,
    planEnabled,
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
    db.query.missions.findMany(buildActiveMissionsQueryArgs(missionsWhere) as any),
    db.query.missions.findMany(buildCompletedMissionsQueryArgs(missionsWhere, completedCursor) as any),
    // "Plan ›" is behind the team's task-estimates switch, like the other estimate surfaces.
    taskEstimatesEnabled(activeTeamId),
  ]);

  const { maxSeats, activeSeats } = seats;
  const { items: completedRows, nextCursor: nextCompletedCursor } = paginateCompletedMissions(
    completedRowsPage as unknown as Array<{ completedAt: Date | string | null; id: string }>,
    COMPLETED_MISSIONS_PAGE_SIZE,
  ) as unknown as { items: typeof completedRowsPage; nextCursor: string | null };

  const allMissions = [...activeRows, ...completedRows] as any[];

  // Load escalation gate verdicts for missions with mission PRs to determine
  // if they should count as needs-you. Only read stored verdicts, no model calls.
  const prKeys: string[] = [];
  const missionByKey = new Map<string, any>();
  for (const m of allMissions) {
    if (m.primaryPrNumber && m.workspaceId) {
      const key = `pr:${m.workspaceId}:${m.primaryPrNumber}`;
      prKeys.push(key);
      missionByKey.set(key, m);
    }
  }
  const verdicts = prKeys.length > 0 ? await loadMissionVerdicts(activeTeamId, prKeys) : new Map();
  for (const [key, verdict] of verdicts) {
    const mission = missionByKey.get(key);
    if (mission) mission.escalationGateVerdict = verdict;
  }

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
    // The strip's cells: the same dependency-first order and display states the mission page draws.
    const projection = taskRowsStripProjection((obj.tasks ?? []) as Parameters<typeof taskRowsStripProjection>[0]);
    const strip = projection.order.flatMap(id => projection.states.get(id) ?? []);
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
      strip,
      nextScanMins: recurring ? summarizeMissionForCard(obj as MissionCardRow, { now }).nextScanMins : null,
    };
  });

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 pb-10 max-w-[1180px]">
      <div className="mb-4 flex items-center justify-between gap-3">
        {/* The mobile header already reads "Missions · Team"; show the h1 from md up only. */}
        <h1 data-testid="missions-headline" className="sr-only md:not-sr-only text-heading font-semibold text-text-primary">
          Missions
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {/* Releases and Initiatives left the primary nav; this is their door. */}
          {planEnabled && (
            <Link href="/app/missions/plan" data-testid="missions-plan-link" className="btn btn-quiet h-11 md:h-8">
              Plan ›
            </Link>
          )}
          <Link href="/app/releases" data-testid="missions-releases-link" className="btn btn-quiet h-11 md:h-8">
            Releases
          </Link>
          <Link href="/app/initiatives" data-testid="missions-initiatives-link" className="btn btn-quiet h-11 md:h-8">
            Initiatives
          </Link>
          <NewWorkLink
            kind="mission"
            workspaceId={wsFilter ?? null}
            testId="new-mission-link"
            className="btn h-11 md:h-8"
          >
            + New
          </NewWorkLink>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-body text-text-secondary">No missions. A mission groups the tasks behind one goal.</p>
      ) : (
        <MissionGrid rows={rows} slots={{ live: activeSeats, max: maxSeats }} now={now} />
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
            className="text-meta text-text-muted hover:text-text-secondary"
          >
            Load older completed missions
          </Link>
        </div>
      )}
    </div>
  );
}
