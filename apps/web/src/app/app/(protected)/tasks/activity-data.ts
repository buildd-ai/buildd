/**
 * Server loader for Activity's Now/History view (spec 3ef37387 R-4, R-11,
 * R-12). Reads the rows, projects them through lib/activity-delivery.ts and
 * returns plain data for the client.
 *
 * What it reads, and only that:
 *  - task rows as narrow columns, with the two review facts Activity shows
 *    taken out of `result` and `context` in SQL (never the JSON itself);
 *  - each loaded task's newest `ACTIVITY_WORKERS_PER_TASK` workers, the
 *    columns the projection reads;
 *  - each mission's header (chip, landed n/m, next step) from its stored
 *    summary (`mission_summaries`, R-13), the reading Home and Missions show,
 *    derived live only for a mission whose summary is not stored yet.
 * Mission and initiative filters narrow every read in SQL, and only the tab
 * on screen is read and built: Now reads the recent roots that may still be
 * in motion, History the live roots that may be finished, and only Now reads
 * local sessions.
 *
 * A mission task's chip is the mission projection's (`projectMissionDelivery`)
 * run over the rows on screen: the task, its attempts and the in-mission
 * tasks it depends on are all a task's delivery reads, so the chip is the one
 * Missions and Home would show without reading the whole mission.
 *
 * This file is core: the missions module's rules arrive as `rules`
 * (scripts/module-boundaries.test.ts), as they do for the projection.
 */
import { db } from '@buildd/core/db';
import { missionSummaries, missions, tasks as tasksTable, workers, workflowDeliveries } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray, isNull, lte, notInArray, or, sql, type AnyColumn, type SQL, type SQLWrapper } from 'drizzle-orm';
import { LIVE_WORKER_STATUSES, MISSION_SUMMARY_VERSION, TERMINAL_TASK_STATUSES } from '@buildd/shared';
import {
  projectMissionDelivery, type MissionDeliveryHead, type MissionTaskRules, type MissionTaskRow, type TaskDelivery,
} from '@/lib/delivery-projection';
import {
  buildActivityHistory, buildActivityNow, reviewOf,
  type ActivityMission, type ActivityNow, type ActivityTaskInput, type Episode,
} from '@/lib/activity-delivery';
import { overlayDeliveryLifecycle } from '@/lib/delivery-overlay';
import { getDeliveryViewsForTasks } from '@/lib/workflow/delivery-view';
import type { LocalHold } from '@/lib/local-session-display';

export type ActivityTab = 'now' | 'history';

export interface ActivityData {
  now: ActivityNow;
  history: Episode[];
}

/**
 * The rows Activity projects, with each kernel-owned delivery's merged/open/closed
 * reading in place of its PR worker's columns. Pure; tasks without a delivery are untouched.
 */
export function overlayActivityRows<W extends object, M extends { tasks?: unknown[] | null }>(input: {
  workersByTask: ReadonlyMap<string, readonly W[]>;
  missions: readonly M[];
  views: Parameters<typeof overlayDeliveryLifecycle>[1];
}): { workersByTask: Map<string, W[]>; missions: M[] } {
  const rows = [...input.workersByTask].map(([id, workers]) => ({ id, workers: [...workers] as unknown as Array<Record<string, unknown>> }));
  const workersByTask = new Map(overlayDeliveryLifecycle(rows, input.views).map(t => [t.id, t.workers as unknown as W[]] as const));
  const missions = input.missions.map(m => ({ ...m, tasks: overlayDeliveryLifecycle((m.tasks ?? []) as Array<{ id: string }>, input.views) as unknown as M['tasks'] }));
  return { workersByTask, missions };
}

const iso = (ms: number | null | undefined) => (ms != null ? new Date(ms).toISOString() : null);

/** Recent roots: the History window. Live work outside it is added on Now. */
export const ACTIVITY_WINDOW_DAYS = 30;
export const ACTIVITY_ROOT_LIMIT = 200;
/** Open or agent-held roots, however old. Bounded so a backlog cannot stall the page. */
export const ACTIVITY_LIVE_ROOT_LIMIT = 500;
/** Attempts for the loaded roots, newest first: a cap drops the oldest retries, never the live one. */
export const ACTIVITY_CHILD_LIMIT = 2000;
/** Workers per task, newest first: the mission projection's own cap (missions/page.tsx). */
export const ACTIVITY_WORKERS_PER_TASK = 5;
/** Missions whose header is derived live per load while their stored summary is missing. */
export const ACTIVITY_LIVE_HEADER_CAP = 20;

/** A timestamp as epoch ms: a third the bytes of its text. */
const epochMs = (col: AnyColumn) => sql<number | null>`(extract(epoch from ${col}) * 1000)::bigint`;

/** Task columns Activity reads: no JSON column, only the facts taken out of it in SQL. */
const isString = (path: SQL) => sql`jsonb_typeof(${path}) = 'string' and ${path} #>> '{}' <> ''`;
export const ACTIVITY_TASK_COLUMNS = {
  id: tasksTable.id,
  title: tasksTable.title,
  status: tasksTable.status,
  mode: tasksTable.mode,
  taskClass: tasksTable.taskClass,
  parentTaskId: tasksTable.parentTaskId,
  missionId: tasksTable.missionId,
  createdAt: epochMs(tasksTable.createdAt).mapWith(Number),
  updatedAt: epochMs(tasksTable.updatedAt).mapWith(Number),
  // An unclaimed task's dependencies decide whether it waits on one; a finished one's never do.
  dependsOn: sql<string[] | null>`case when ${notInArray(tasksTable.status, [...TERMINAL_TASK_STATUSES])} then ${tasksTable.dependsOn} end`,
  // reviewOf's two inputs: the effective verdict wins over the model's own.
  reviewVerdict: sql<string | null>`case
    when ${isString(sql`${tasksTable.result}->'effectiveVerdict'`)} then ${tasksTable.result}->>'effectiveVerdict'
    when ${isString(sql`${tasksTable.result}->'structuredOutput'->'verdict'`)} then ${tasksTable.result}->'structuredOutput'->>'verdict' end`,
  reviewHeadSha: sql<string | null>`case when ${isString(sql`${tasksTable.context}->'headSha'`)} then ${tasksTable.context}->>'headSha' end`,
};

export interface ActivityTaskRow {
  id: string;
  title: string;
  status: string;
  mode: string | null;
  taskClass: string | null;
  parentTaskId: string | null;
  missionId: string | null;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  dependsOn: string[] | null;
  reviewVerdict: string | null;
  reviewHeadSha: string | null;
}

export interface ActivityWorkerRow {
  /** Live workers only: a local session's hold is only ever on a live one (`localHoldsByWorker`). */
  id: string | null;
  taskId: string | null;
  status: string;
  /** Live workers only: Activity names the runner of the agent working a row, never a finished one. */
  name: string | null;
  // Epoch ms.
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number | null;
  prUrl: string | null;
  prNumber: number | null;
  mergedAt: number | null;
  prLifecycleStatus: string | null;
  supersededByPrNumber: number | null;
  abandonedAt: number | null;
  lastCommitSha: string | null;
  /** A waiting worker's question: '' when it has none, null when not waiting. */
  waitingPrompt: string | null;
}

/** A mission in view: its title, and its stored header when it is open. */
export interface ActivityMissionRow {
  id: string;
  title: string;
  status: string;
  head: Pick<MissionDeliveryHead, 'kind' | 'landed' | 'total' | 'next'> | null;
}

export interface ActivityScope {
  workspaceIds: readonly string[];
  missionId?: string | null;
  initiativeId?: string | null;
}

/** Tasks in scope: the workspaces, then the mission or the initiative's missions. */
export function activityScopeWhere(scope: ActivityScope): SQL | undefined {
  return and(
    inArray(tasksTable.workspaceId, [...scope.workspaceIds]),
    scope.missionId ? eq(tasksTable.missionId, scope.missionId)
      : scope.initiativeId ? inArray(tasksTable.missionId, db.select({ id: missions.id }).from(missions).where(eq(missions.initiativeId, scope.initiativeId)))
      : undefined,
  );
}

/**
 * Roots that belong in Now however long ago they were last touched: not
 * terminal, or with an agent live on them or on one of their attempts.
 * The recent window alone starves these on a busy workspace: a root's
 * `updatedAt` does not move while a repair attempt runs, so fresh completed
 * work pushes it out. Roots the recent window already holds are left out.
 */
export function liveRootsWhere(scope: ActivityScope, recentIds: SQLWrapper, tab: ActivityTab): SQL | undefined {
  const where = activityScopeWhere(scope);
  const open = db.select({ id: tasksTable.id }).from(tasksTable)
    .where(and(where, isNull(tasksTable.parentTaskId), notInArray(tasksTable.status, [...TERMINAL_TASK_STATUSES])))
    .orderBy(desc(tasksTable.updatedAt))
    .limit(ACTIVITY_LIVE_ROOT_LIMIT);
  const held = db.select({ id: sql`coalesce(${tasksTable.parentTaskId}, ${tasksTable.id})` }).from(workers)
    .innerJoin(tasksTable, eq(workers.taskId, tasksTable.id))
    .where(and(inArray(workers.workspaceId, [...scope.workspaceIds]), where, inArray(workers.status, [...LIVE_WORKER_STATUSES])))
    .limit(ACTIVITY_LIVE_ROOT_LIMIT);
  return and(where, or(inArray(tasksTable.id, open), inArray(tasksTable.id, held)), notInArray(tasksTable.id, recentIds),
    tab === 'history' ? mayBeFinishedSql() : undefined);
}

const LIVE_WORKER = sql`${workers.status} in (${sql.join(LIVE_WORKER_STATUSES.map(st => sql`${st}`), sql`, `)})`;
const toMs = (v: unknown): number | null => (v == null ? null : Number(v));

/** Each named task's newest `ACTIVITY_WORKERS_PER_TASK` workers, the columns Activity reads. */
function workersQuery(taskIdsIn: SQL | undefined) {
  const ranked = db.select({
    id: sql<string | null>`case when ${LIVE_WORKER} then ${workers.id} end`.as('id'),
    taskId: workers.taskId, status: workers.status,
    name: sql<string | null>`case when ${LIVE_WORKER} then ${workers.name} end`.as('name'),
    startedAt: epochMs(workers.startedAt).as('started_ms'),
    completedAt: epochMs(workers.completedAt).as('completed_ms'),
    updatedAt: epochMs(workers.updatedAt).as('updated_ms'),
    prUrl: workers.prUrl, prNumber: workers.prNumber,
    mergedAt: epochMs(workers.mergedAt).as('merged_ms'),
    prLifecycleStatus: workers.prLifecycleStatus, supersededByPrNumber: workers.supersededByPrNumber,
    abandonedAt: epochMs(workers.abandonedAt).as('abandoned_ms'),
    lastCommitSha: workers.lastCommitSha,
    waitingPrompt: sql<string | null>`case when ${workers.status} = 'waiting_input' and ${workers.waitingFor} is not null
      then coalesce(${workers.waitingFor}->>'prompt', '') end`.as('waiting_prompt'),
    rn: sql<number>`row_number() over (partition by ${workers.taskId} order by ${workers.startedAt} desc, ${workers.updatedAt} desc, ${workers.id})`.as('rn'),
  }).from(workers).where(taskIdsIn).as('w');
  return db.select({
    id: ranked.id, taskId: ranked.taskId, status: ranked.status, name: ranked.name,
    startedAt: ranked.startedAt, completedAt: ranked.completedAt, updatedAt: ranked.updatedAt,
    prUrl: ranked.prUrl, prNumber: ranked.prNumber, mergedAt: ranked.mergedAt, prLifecycleStatus: ranked.prLifecycleStatus,
    supersededByPrNumber: ranked.supersededByPrNumber, abandonedAt: ranked.abandonedAt, lastCommitSha: ranked.lastCommitSha,
    waitingPrompt: ranked.waitingPrompt,
  }).from(ranked).where(lte(ranked.rn, ACTIVITY_WORKERS_PER_TASK)).orderBy(sql`${ranked.taskId}`, sql`${ranked.rn}`);
}

const kernelOwned = sql`(${tasksTable.deliveryId} is not null
    or exists (select 1 from ${workflowDeliveries} where ${workflowDeliveries.ownerTaskId} = ${tasksTable.id}))`;
/** A worker of the root, or of one of its attempts, matching `cond`: two lookups on workers_task_idx (an OR in one scans every worker per root). */
const familyWorker = (cond: SQL) => sql`(exists (select 1 from ${workers} where ${workers.taskId} = ${tasksTable.id} and ${cond})
    or exists (select 1 from tasks a join ${workers} on ${workers.taskId} = a.id where a.parent_task_id = ${tasksTable.id} and ${cond}))`;

/**
 * A finished root Now may still show: one whose delivery can be in motion. A
 * root with no live agent, no PR open by its workers' own columns (on it or
 * an attempt) and no kernel-owned delivery (whose reading can reopen a PR)
 * projects as landed or not landed, which is History's. Coarser than the
 * projection, never narrower: every root it keeps still goes through it.
 */
export function mayBeInMotionSql(): SQL {
  return sql`(${kernelOwned} or ${familyWorker(sql`(${LIVE_WORKER} or (${workers.prUrl} is not null and ${workers.mergedAt} is null
    and ${workers.supersededByPrNumber} is null and ${workers.abandonedAt} is null
    and coalesce(${workers.prLifecycleStatus}, '') not in ('merged', 'closed')))`)})`;
}

/**
 * A live root History may still show: one whose delivery can be finished
 * while the task is open or an agent is on it. Only a PR that merged, closed,
 * was carried by another or set aside (or a kernel-owned delivery) finishes
 * one; without a PR an open task is waiting or being built. Coarser than the
 * projection, never narrower.
 */
export function mayBeFinishedSql(): SQL {
  return sql`(${kernelOwned} or ${familyWorker(sql`(${workers.prUrl} is not null and (${workers.mergedAt} is not null
    or ${workers.supersededByPrNumber} is not null or ${workers.abandonedAt} is not null
    or ${workers.prLifecycleStatus} in ('merged', 'closed')))`)})`;
}

/** The missions in view, each with its stored header (null when not stored at this version). */
function missionsQuery(ids: string[]) {
  const d = sql`(${missionSummaries.summary}->'home'->'delivery')`;
  return db.select({
    id: missions.id, title: missions.title, status: missions.status,
    head: sql<ActivityMissionRow['head']>`case when ${d} is null then null else jsonb_build_object(
      'kind', ${d}->'kind', 'landed', ${d}->'landed', 'total', ${d}->'total', 'next', ${d}->'next') end`,
  })
    .from(missions)
    .leftJoin(missionSummaries, and(eq(missionSummaries.missionId, missions.id), eq(missionSummaries.version, MISSION_SUMMARY_VERSION)))
    .where(inArray(missions.id, ids));
}

const uniq = <T>(xs: Iterable<T | null | undefined>): T[] => [...new Set([...xs].filter((x): x is T => x != null))];

export interface ActivityLoad {
  rows: ActivityTaskRow[];
  /** Tasks a waiting row depends on that are not in view: chip inputs only, never rows. */
  dependencies: ActivityTaskRow[];
  workers: ActivityWorkerRow[];
  missions: ActivityMissionRow[];
  /** Set when the root cap, not the window, ended the recent roots. */
  historyReach: { oldestAt: string } | null;
}

/**
 * Activity's reads for one tab, in three round trips: the recent and the
 * live roots in one batch; their attempts, workers and the dependencies
 * of waiting rows in a second; the missions and the kernel's delivery views
 * side by side in a third.
 */
export async function loadActivityRows(scope: ActivityScope, tab: ActivityTab, nowMs: number): Promise<ActivityLoad & { views: Awaited<ReturnType<typeof getDeliveryViewsForTasks>> }> {
  const empty = { rows: [], dependencies: [], workers: [], missions: [], historyReach: null, views: new Map() };
  if (scope.workspaceIds.length === 0) return empty;
  const where = activityScopeWhere(scope);
  const windowStart = new Date(nowMs - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // Now reads the recent roots that may still be in motion; History all of them.
  const recentWhere = and(where, gte(tasksTable.updatedAt, windowStart), isNull(tasksTable.parentTaskId),
    tab === 'now' ? or(notInArray(tasksTable.status, [...TERMINAL_TASK_STATUSES]), mayBeInMotionSql()) : undefined);
  const recentQuery = db.select(ACTIVITY_TASK_COLUMNS).from(tasksTable).where(recentWhere)
    .orderBy(desc(tasksTable.updatedAt)).limit(ACTIVITY_ROOT_LIMIT);

  const recentIds = db.select({ id: tasksTable.id }).from(tasksTable).where(recentWhere)
    .orderBy(desc(tasksTable.updatedAt)).limit(ACTIVITY_ROOT_LIMIT);
  const [recent, live] = await db.batch([
    recentQuery,
    db.select(ACTIVITY_TASK_COLUMNS).from(tasksTable).where(liveRootsWhere(scope, recentIds, tab)),
  ]);
  const historyReach = tab === 'history' && recent.length >= ACTIVITY_ROOT_LIMIT ? { oldestAt: new Date(recent[recent.length - 1].updatedAt).toISOString() } : null;
  const roots = [...recent, ...live];
  if (roots.length === 0) return { ...empty, historyReach };

  // Attempts (retry/reviewer) of the loaded roots, newest first so a cap drops
  // the oldest attempts, never a live one; every loaded task's workers; and
  // the in-mission tasks a waiting root depends on, with their attempts.
  const rootIds = roots.map(t => t.id);
  const loaded = new Set(rootIds);
  const depIds = uniq(roots.filter(t => t.missionId).flatMap(t => t.dependsOn ?? [])).filter(id => !loaded.has(id));
  const childWhere = and(where, inArray(tasksTable.parentTaskId, rootIds));
  const childIds = db.select({ id: tasksTable.id }).from(tasksTable).where(childWhere)
    .orderBy(desc(tasksTable.createdAt)).limit(ACTIVITY_CHILD_LIMIT);
  const depWhere = depIds.length > 0
    ? and(inArray(tasksTable.workspaceId, [...scope.workspaceIds]), or(inArray(tasksTable.id, depIds), inArray(tasksTable.parentTaskId, depIds)))
    : undefined;
  const workerTasks = or(
    inArray(workers.taskId, rootIds),
    inArray(workers.taskId, childIds),
    depWhere ? inArray(workers.taskId, db.select({ id: tasksTable.id }).from(tasksTable).where(depWhere)) : undefined,
  );
  const childQuery = db.select(ACTIVITY_TASK_COLUMNS).from(tasksTable).where(childWhere)
    .orderBy(desc(tasksTable.createdAt)).limit(ACTIVITY_CHILD_LIMIT);
  const [children, workerRows, dependencies] = depWhere
    ? await db.batch([childQuery, workersQuery(workerTasks), db.select(ACTIVITY_TASK_COLUMNS).from(tasksTable).where(depWhere)])
    : [...await db.batch([childQuery, workersQuery(workerTasks)]), [] as ActivityTaskRow[]];

  const rows = [...new Map([...roots, ...children].map(t => [t.id, t])).values()];
  const missionIds = uniq([...rows.map(t => t.missionId), scope.missionId]);
  const [missionRows, views] = await Promise.all([
    missionIds.length > 0 ? missionsQuery(missionIds) : Promise.resolve([]),
    // A kernel-owned delivery's merged/open/closed reading replaces its PR worker's columns
    // (workflow-kernel-library §7); work without one keeps the worker rows.
    getDeliveryViewsForTasks(uniq([...rows, ...dependencies].map(t => t.id))).catch(() => new Map()),
  ]);
  const ms = (w: Record<string, unknown>): ActivityWorkerRow => ({
    ...(w as unknown as ActivityWorkerRow),
    startedAt: toMs(w.startedAt), completedAt: toMs(w.completedAt), updatedAt: toMs(w.updatedAt), mergedAt: toMs(w.mergedAt), abandonedAt: toMs(w.abandonedAt),
  });
  return { rows, dependencies, workers: (workerRows as Array<Record<string, unknown>>).map(ms), missions: missionRows as ActivityMissionRow[], historyReach, views };
}

/**
 * Each mission task's delivery, as the mission projection reads it: the
 * projection run over the mission's rows in view (tasks, their attempts and
 * the tasks they depend on). A task's delivery reads nothing else of its
 * mission, so the chip is the one the whole mission's projection gives.
 */
export function missionTaskDeliveries(rows: readonly (MissionTaskRow & { missionId?: string | null })[], missionIds: Iterable<string>, rules: MissionTaskRules): Map<string, TaskDelivery> {
  const out = new Map<string, TaskDelivery>();
  for (const missionId of missionIds) {
    const own = rows.filter(t => t.missionId === missionId);
    if (own.length === 0) continue;
    const m = projectMissionDelivery({ id: missionId, title: '', status: 'active', href: '', tasks: own }, rules);
    for (const t of m.tasks) out.set(t.id, t.delivery);
  }
  return out;
}

export async function loadActivity(input: {
  scope: ActivityScope;
  tab: ActivityTab;
  /**
   * Worker id → the local session holding it (`localHoldsByWorker`). Names the
   * client, and a quiet or ended session's worker reads as a held slot, not an agent live.
   */
  localHolds: ReadonlyMap<string, LocalHold> | Promise<ReadonlyMap<string, LocalHold>>;
  now: number;
  /** `@buildd/core/mission-helpers`, passed by the page. */
  rules: MissionTaskRules;
  /** Live header for open missions with no stored summary yet (lib/mission-summary-home.ts). */
  deriveHeads?: (ids: string[]) => Promise<Map<string, ActivityMissionRow['head']>>;
}): Promise<ActivityData & { historyReach: ActivityLoad['historyReach']; missionTitle: string | null }> {
  const { rules, scope } = input;
  const [load, localHolds] = await Promise.all([loadActivityRows(scope, input.tab, input.now), input.localHolds]);

  const byTask = new Map<string, ActivityWorkerRow[]>();
  for (const w of load.workers) if (w.taskId) byTask.set(w.taskId, [...(byTask.get(w.taskId) ?? []), w]);
  const overlaid = overlayActivityRows({ workersByTask: byTask, missions: [], views: load.views });
  for (const [id, ws] of overlaid.workersByTask) byTask.set(id, ws);

  const missionById = new Map(load.missions.map(m => [m.id, m]));
  // Open missions only, as Missions and Home group them; a completed mission's tasks project on their own.
  const open = load.missions.filter(m => m.status !== 'completed');
  const missing = open.filter(m => !m.head).map(m => m.id);
  if (missing.length > 0 && input.deriveHeads) {
    const heads = await input.deriveHeads(missing.slice(0, ACTIVITY_LIVE_HEADER_CAP)).catch((err) => {
      console.warn('[activity] live mission header derive failed:', err instanceof Error ? err.message : err);
      return new Map<string, ActivityMissionRow['head']>();
    });
    for (const [id, head] of heads) {
      const m = missionById.get(id);
      if (m && head) m.head = head;
    }
  }

  const projectionRows = [...load.rows, ...load.dependencies].map(t => ({ ...t, workers: byTask.get(t.id) ?? [] }));
  const deliveries = missionTaskDeliveries(projectionRows, open.map(m => m.id), rules);
  const missionsInView: ActivityMission[] = open.map(m => {
    const tasks = projectionRows.filter(t => t.missionId === m.id && deliveries.has(t.id)).map(t => ({ id: t.id, title: t.title, delivery: deliveries.get(t.id)! }));
    // Not stored and not derived (past the cap): the projection over the rows in view.
    const head = m.head ?? projectMissionDelivery({ id: m.id, title: m.title, status: m.status, href: '', tasks: projectionRows.filter(t => t.missionId === m.id) }, rules);
    return { id: m.id, title: m.title, kind: head.kind, landed: head.landed, total: head.total, next: head.next, tasks };
  });

  const tasks: ActivityTaskInput[] = load.rows.map(t => {
    const ws = byTask.get(t.id) ?? [];
    const type = rules.deriveTaskType(t);
    const isReview = type === 'review' || type === 'review-retry';
    const waiting = ws.find(w => w.status === 'waiting_input');
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      mode: t.mode,
      taskClass: t.taskClass,
      parentTaskId: t.parentTaskId,
      missionId: t.missionId,
      missionTitle: t.missionId ? missionById.get(t.missionId)?.title ?? null : null,
      createdAt: new Date(t.createdAt).toISOString(),
      updatedAt: new Date(t.updatedAt).toISOString(),
      waitingPrompt: waiting && waiting.waitingPrompt != null ? waiting.waitingPrompt || 'Has a question' : null,
      review: isReview ? reviewOf({ effectiveVerdict: t.reviewVerdict }, { headSha: t.reviewHeadSha }) : null,
      workers: ws.map(w => ({
        status: w.status,
        name: (w.id && localHolds.get(w.id)?.client) || w.name,
        local: (w.id && localHolds.get(w.id)) || null,
        startedAt: iso(w.startedAt),
        completedAt: iso(w.completedAt),
        updatedAt: iso(w.updatedAt),
        prUrl: w.prUrl,
        prNumber: w.prNumber,
        mergedAt: iso(w.mergedAt),
        prLifecycleStatus: w.prLifecycleStatus,
        supersededByPrNumber: w.supersededByPrNumber,
        abandonedAt: iso(w.abandonedAt),
        lastCommitSha: w.lastCommitSha,
      })),
    };
  });

  // Only the tab on screen is built (R-12).
  const args = { tasks, missions: missionsInView, rules };
  return {
    now: input.tab === 'now' ? buildActivityNow({ ...args, now: input.now }) : { groups: [], inMotion: 0, liveAgents: 0 },
    history: input.tab === 'history' ? buildActivityHistory(args) : [],
    historyReach: load.historyReach,
    missionTitle: scope.missionId ? missionById.get(scope.missionId)?.title ?? null : null,
  };
}
