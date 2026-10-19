/**
 * The missions list's one loader (spec 3ef37387 R-2, R-11, R-12, R-13): every
 * row from the mission's stored summary (`mission_summaries`), never from its
 * tasks and workers. A row's delivery is the summary's `home.delivery`, the
 * card Home shows, so the two surfaces build the same card from one
 * derivation (`computeMissionSummary`); the strip, last advance and next run
 * are its `list` reading.
 *
 * One round trip reads the open missions (every one, Rule P-3), one keyset
 * page of completed ones (Rule P-4), and the team's seats. A mission whose
 * summary is not stored yet (just created, or not backfilled after a version
 * bump) is derived live from its rows, at most `LIVE_DERIVE_CAP` per load,
 * without the visual review (that may reach GitHub; the stored summary has
 * it), and noted for a summary write after the response.
 */
import { db } from '@buildd/core/db';
import { accounts, initiatives, missionSummaries, missions, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { MISSION_SUMMARY_VERSION, type MissionSummaryList } from '@buildd/shared';
import type { StateKey } from '@/components/ui/states';
import { deliveryAtRead, type MissionDeliveryRow } from './delivery-projection';
import type { PortfolioDelivery, PortfolioRow } from './mission-portfolio';
import { LIVE_WORKER_STATUSES } from './task-presentation';
import { COMPLETED_MISSIONS_PAGE_SIZE, paginateCompletedMissions, type CompletedMissionCursor } from './missions-query';
import { deriveHomeReadings } from './mission-summary-home';
import { refreshMissionSummary } from './mission-summary-store';

/** Missions derived live per load while their stored summary is missing. */
export const LIVE_DERIVE_CAP = 50;

export interface MissionListView {
  rows: PortfolioRow[];
  nextCompletedCursor: string | null;
  slots: { live: number; max: number };
}

interface ListRow {
  id: string;
  title: string;
  status: string;
  workspaceId: string | null;
  workspaceName: string | null;
  groupId: string | null;
  groupName: string | null;
  priority: number | null;
  completedAt: Date | string | null;
  /** The fields of the stored delivery row a portfolio row shows (`LeanDelivery`); null when no summary is stored. */
  delivery: LeanDelivery | null;
  liveWorkers: number | null;
  list: MissionSummaryList | null;
}

/** A row's delivery without what the row's own columns carry (id, title, link). */
type LeanDelivery = Omit<PortfolioDelivery, 'id' | 'title' | 'href'> & { quietSince?: number | null };

/**
 * The stored delivery row cut to what the grid renders. An open mission's row
 * shows its state, fraction and next step (and, when it needs a person, the
 * evidence); a finished one (completed or archived) only its fraction.
 */
const leanDeliverySql = (d: SQL) => sql`case when ${d} is null then null when (${d}->>'open')::boolean then jsonb_build_object(
    'kind', ${d}->'kind', 'startState', ${d}->'startState', 'open', true, 'landed', ${d}->'landed', 'total', ${d}->'total',
    'next', ${d}->'next', 'evidence', case when ${d}->>'kind' = 'needs' then ${d}->'evidence' else '""'::jsonb end,
    'remaining', ${d}->'remaining', 'reconciling', ${d}->'reconciling', 'repairRounds', ${d}->'repairRounds', 'quietSince', ${d}->'quietSince')
  else jsonb_build_object('kind', ${d}->'kind', 'open', false, 'landed', ${d}->'landed', 'total', ${d}->'total', 'next', '', 'evidence', '', 'startState', null, 'repairRounds', 0) end`;

/** A finished mission's row draws no strip and no next run: only when it last moved. */
const leanListSql = (summary: SQL) => sql`case when ${summary}->'list' is null then null when (${summary}->'home'->'delivery'->>'open')::boolean then ${summary}->'list'
  else jsonb_build_object('strip', '[]'::jsonb, 'nextRunAt', null, 'lastAdvancedAt', ${summary}->'list'->'lastAdvancedAt') end`;

const leanOf = (d: MissionDeliveryRow): LeanDelivery => d.open
  ? { kind: d.kind, startState: d.startState, open: true, landed: d.landed, total: d.total, next: d.next, evidence: d.kind === 'needs' ? d.evidence : '', remaining: d.remaining, reconciling: d.reconciling, repairRounds: d.repairRounds, quietSince: d.quietSince ?? null }
  : { kind: d.kind, open: false, landed: d.landed, total: d.total, next: '', evidence: '', startState: null, repairRounds: 0 };

function listRowsQuery(where: SQL | undefined) {
  const stored = and(eq(missionSummaries.missionId, missions.id), eq(missionSummaries.version, MISSION_SUMMARY_VERSION));
  return db.select({
    id: missions.id, title: missions.title, status: missions.status, workspaceId: missions.workspaceId,
    workspaceName: workspaces.name, groupId: missions.initiativeId, groupName: initiatives.title,
    priority: missions.priority, completedAt: missions.completedAt,
    delivery: sql<ListRow['delivery']>`${leanDeliverySql(sql`(${missionSummaries.summary}->'home'->'delivery')`)}`,
    liveWorkers: sql<number | null>`(${missionSummaries.summary}->>'liveWorkers')::int`,
    list: sql<MissionSummaryList | null>`${leanListSql(sql`${missionSummaries.summary}`)}`,
  })
    .from(missions)
    .leftJoin(missionSummaries, stored)
    .leftJoin(workspaces, eq(workspaces.id, missions.workspaceId))
    .leftJoin(initiatives, eq(initiatives.id, missions.initiativeId))
    .where(where);
}

/**
 * The list for one team, optionally narrowed to a workspace (team-level
 * missions, with no workspace, always stay). `completedCursor` pages the
 * completed missions; the open ones are always all there.
 */
export async function loadMissionList(opts: {
  teamId: string;
  workspaceId?: string | null;
  completedCursor: CompletedMissionCursor | null;
  now: number;
}): Promise<MissionListView> {
  const { teamId, workspaceId, completedCursor, now } = opts;
  const scope = workspaceId
    ? and(eq(missions.teamId, teamId), or(eq(missions.workspaceId, workspaceId), isNull(missions.workspaceId)))
    : eq(missions.teamId, teamId);
  const cursorClause = completedCursor
    ? or(
        lt(missions.completedAt, new Date(completedCursor.completedAt)),
        and(eq(missions.completedAt, new Date(completedCursor.completedAt)), lt(missions.id, completedCursor.id)),
      )
    : undefined;
  const teamAccounts = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.teamId, teamId));

  const [openRows, completedPage, seatRows] = await db.batch([
    listRowsQuery(and(scope, ne(missions.status, 'completed')))
      .orderBy(desc(missions.priority), desc(missions.lastTaskStartedAt), desc(missions.updatedAt)),
    listRowsQuery(and(scope, eq(missions.status, 'completed'), cursorClause))
      .orderBy(desc(missions.completedAt), desc(missions.id))
      .limit(COMPLETED_MISSIONS_PAGE_SIZE + 1),
    // Seats across the team's accounts, and the live workers on them.
    db.select({
      max: sql<number>`coalesce(sum(${accounts.maxConcurrentWorkers}), 0)::int`,
      live: sql<number>`(select count(*)::int from ${workers} where ${inArray(workers.accountId, teamAccounts)} and ${inArray(workers.status, [...LIVE_WORKER_STATUSES])})`,
    }).from(accounts).where(eq(accounts.teamId, teamId)),
  ]);

  const { items: completedRows, nextCursor: nextCompletedCursor } = paginateCompletedMissions(completedPage, COMPLETED_MISSIONS_PAGE_SIZE);

  const all = [...openRows, ...completedRows] as ListRow[];
  const missing = all.filter(r => !r.delivery || !r.list).map(r => r.id);
  if (missing.length > 0) {
    // Written after the response; this load derives what it can now.
    refreshMissionSummary(...missing);
    const live = await deriveHomeReadings(missing.slice(0, LIVE_DERIVE_CAP), now).catch(err => {
      console.error('[missions] live summary derive failed:', err);
      return [];
    });
    const byId = new Map(live.map(r => [r.id, r]));
    for (const row of all) {
      const d = byId.get(row.id);
      if (!d) continue;
      row.delivery = leanOf(d.home.delivery);
      row.list = d.home.delivery.open ? d.list : { strip: [], nextRunAt: null, lastAdvancedAt: d.list.lastAdvancedAt };
      row.liveWorkers = d.liveWorkers;
    }
  }

  const rows: PortfolioRow[] = [];
  for (const r of all) {
    // Past the live cap with no stored summary: left out of this load, listed once its summary is written.
    if (!r.delivery || !r.list) continue;
    const { quietSince: _anchor, ...lean } = deliveryAtRead(r.delivery, now);
    rows.push({
      delivery: { id: r.id, title: r.title, href: `/app/missions/${r.id}`, ...lean },
      status: r.status,
      workspaceId: r.workspaceId ?? null,
      workspaceName: r.workspaceName ?? null,
      groupId: r.groupId ?? null,
      groupName: r.groupName ?? null,
      priority: r.priority ?? 0,
      liveAgents: r.liveWorkers ?? 0,
      lastAdvancedAt: r.list.lastAdvancedAt ? new Date(r.list.lastAdvancedAt).getTime() : null,
      completedAt: r.completedAt ? new Date(r.completedAt).getTime() : null,
      strip: r.list.strip as StateKey[],
      nextScanMins: r.list.nextRunAt ? Math.max(0, Math.round((new Date(r.list.nextRunAt).getTime() - now) / 60_000)) : null,
    });
  }
  const seats = seatRows[0];
  return { rows, nextCompletedCursor, slots: { live: Number(seats?.live ?? 0), max: Number(seats?.max ?? 0) } };
}
