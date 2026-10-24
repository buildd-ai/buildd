/**
 * What waits on a task's open question (Living Spec 1b257609 revision 2,
 * R-1 to R-5, R-10): the question part of the mission-state projection,
 * computed once, from the database, with no model. The words are
 * packages/core/question-waits.ts. Every surface reads this and nothing else:
 * the decision card on Home (lib/home-attention.ts), the mission page
 * (lib/mission-decisions.ts), the task page (GET /api/tasks/[id]/question-waits),
 * the push (worker PATCH, lib/question-hold-notify.ts), get_task
 * (GET /api/tasks/[id]) and explain. `scripts/question-waits-single-source.test.ts`
 * fails a surface that builds its own list (AC-9).
 *
 * - Declared dependents one and two steps out, open only, and a count of the
 *   open ones one step further: the edges the claim route's dependency gate
 *   holds on. An edge only the path-overlap pass added
 *   (`pathDeclaration.inferredDependsOn`) is a guess about files, not a
 *   declared dependency, and is left out (AC-3).
 * - The tasks queued behind a serial lane the task holds, in lane order
 *   (`QuestionWaitsIo.loadLaneWaits`). Serial lanes are not on this branch
 *   yet; until they are, the database source reports none.
 * - Each task is resolved for the viewer by `resolveDependencyHolders` (spec
 *   e28018c2): one the viewer cannot see is counted, and nothing else about
 *   it is returned.
 * - The mission, and the outcome-spec criteria the task supplies evidence for
 *   (`affectedCriteria`).
 * - When the question was asked (the worker's park clock, `updatedAt`), when
 *   the waiting-input sweep closes it and what that sweep then does
 *   (`expiryOf`, mirroring lib/stale-workers.ts `cleanupStuckWaitingInput`).
 *
 * Reads go through `QuestionWaitsIo` so the rules are tested without a database.
 */
import { db } from '@buildd/core/db';
import { missions, specCriterionRecords, specs, tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, notInArray, or, sql, asc } from 'drizzle-orm';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { INTERACTIVE_WORKER_RUNNER, TERMINAL_TASK_STATUSES, type GoalCriterion, type LivingSpecGoalCriterion } from '@buildd/shared';
import {
  optionOutcomes,
  type ExpiryAction,
  type LaneWait,
  type QuestionWaits,
  type WaitingTask,
} from '@buildd/core/question-waits';
import { PARK_MAX_MS, PARK_MISSION_MAX_MS } from './worker-park';
import { resolveDependencyHolders, type DependencyHolder, type DependencyViewer } from './task-dependency-reach';

/** At most this many dependents are read per step. */
export const WAITS_STEP_LIMIT = 50;

export interface AskingTask {
  id: string;
  title: string;
  workspaceId: string;
  teamId: string | null;
  missionId: string | null;
  deliveryId: string | null;
  context: unknown;
  pathManifest: string[] | null;
}

export interface DependentRow {
  id: string;
  title: string;
  workspaceId: string;
  missionId: string | null;
  dependsOn: string[];
  /** Edges the path-overlap pass added (released, not failed, when the upstream fails). */
  inferredDependsOn: string[];
}

export interface WaitingWorkerRow {
  runner: string;
  updatedAt: Date | string;
  waitingFor: unknown;
}

export interface MissionRow {
  id: string;
  title: string;
  executor: string | null;
  goalCriteria: GoalCriterion[] | null;
}

export interface SpecRow {
  title: string;
  verifiedBy: string[] | Record<string, string[]> | null;
  criterionIds: string[];
}

/** One serial lane the task holds, members behind it in lane order (position 2 is next). */
export interface LaneRow {
  lane: string;
  queued: Array<{ id: string; title: string; position: number }>;
}

export interface QuestionWaitsIo {
  loadTask(id: string): Promise<AskingTask | null>;
  /** The lanes the task holds and who is queued behind it, from the claim route's lane read. */
  loadLaneWaits(task: AskingTask): Promise<LaneRow[]>;
  loadWaitingWorker(taskId: string): Promise<WaitingWorkerRow | null>;
  /** Open tasks whose dependsOn names any of `ids`. */
  loadDependents(ids: readonly string[]): Promise<DependentRow[]>;
  loadStatuses(ids: readonly string[]): Promise<Array<{ id: string; status: string }>>;
  loadMissions(ids: readonly string[]): Promise<MissionRow[]>;
  loadSpec(specId: string, specRevisionId: string): Promise<SpecRow | null>;
  resolve(scope: { viewer: DependencyViewer; teamId: string | null; dependentWorkspaceId: string | null }, ids: readonly string[]): Promise<Map<string, DependencyHolder>>;
}

const SATISFIED = new Set(['completed', 'cancelled']);
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const dbIo: QuestionWaitsIo = {
  async loadTask(id) {
    const row = await db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, id)),
      columns: { id: true, title: true, workspaceId: true, missionId: true, deliveryId: true, context: true, pathManifest: true },
      with: { workspace: { columns: { teamId: true } } },
    }) as (Omit<AskingTask, 'teamId'> & { workspace?: { teamId: string | null } | null }) | undefined;
    if (!row) return null;
    return { ...row, teamId: row.workspace?.teamId ?? null, pathManifest: asStrings(row.pathManifest) };
  },
  async loadWaitingWorker(taskId) {
    const row = await db.query.workers.findFirst({
      where: sqlWhere(and(eq(workers.taskId, taskId), eq(workers.status, 'waiting_input'))),
      columns: { runner: true, updatedAt: true, waitingFor: true },
      orderBy: sqlOrderBy([desc(workers.updatedAt)]),
    });
    return row ?? null;
  },
  async loadDependents(ids) {
    if (ids.length === 0) return [];
    const rows = await db
      .select({ id: tasks.id, title: tasks.title, workspaceId: tasks.workspaceId, missionId: tasks.missionId, dependsOn: tasks.dependsOn, pathDeclaration: tasks.pathDeclaration })
      .from(tasks)
      .where(and(
        or(...ids.map(id => sql`${tasks.dependsOn} @> ${JSON.stringify([id])}::jsonb`)),
        notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
      ))
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .limit(WAITS_STEP_LIMIT * 2);
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      workspaceId: r.workspaceId,
      missionId: r.missionId,
      dependsOn: asStrings(r.dependsOn),
      inferredDependsOn: asStrings((r.pathDeclaration as { inferredDependsOn?: unknown } | null)?.inferredDependsOn),
    }));
  },
  async loadStatuses(ids) {
    if (ids.length === 0) return [];
    return db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(inArray(tasks.id, [...ids]));
  },
  async loadMissions(ids) {
    if (ids.length === 0) return [];
    const rows = await db
      .select({ id: missions.id, title: missions.title, executor: missions.executor, goalCriteria: missions.goalCriteria })
      .from(missions)
      .where(inArray(missions.id, [...ids]));
    return rows as MissionRow[];
  },
  async loadSpec(specId, specRevisionId) {
    const [spec] = await db.select({ title: specs.title, metadata: specs.metadata }).from(specs).where(eq(specs.id, specId)).limit(1);
    if (!spec) return null;
    const rows = await db
      .select({ criterionId: specCriterionRecords.criterionId })
      .from(specCriterionRecords)
      .where(eq(specCriterionRecords.specRevisionId, specRevisionId))
      .orderBy(asc(specCriterionRecords.position));
    return { title: spec.title, verifiedBy: spec.metadata?.verified_by ?? null, criterionIds: rows.map(r => r.criterionId) };
  },
  // Serial lanes (Overlap scheduling, 75217f55) are not on this branch: no
  // task holds one. Wire to the lane read (lib/serial-lanes-store.ts
  // `loadLanes`) when it lands.
  async loadLaneWaits() { return []; },
  resolve: (scope, ids) => resolveDependencyHolders(scope, ids),
};

/**
 * When the waiting-input sweep closes the question and what it then does
 * (lib/stale-workers.ts `cleanupStuckWaitingInput`): 4 hours in a mission, 24
 * otherwise. A delivery's run is the delivery's to restart; an interactive
 * session outside a local mission is not retried, so the task ends; anything
 * else starts again without the answer, taking the agent's recommended option
 * when it named one (runner prompt-builder `renderUnansweredQuestion`).
 */
export function expiryOf(input: {
  askedAt: Date | string | null;
  missionId: string | null;
  missionExecutor: string | null;
  runner: string | null;
  deliveryId: string | null;
  recommended: string | null;
}): { expiresAt: string | null; onExpiry: { action: ExpiryAction; option: string | null } } {
  const asked = input.askedAt ? new Date(input.askedAt).getTime() : NaN;
  const expiresAt = Number.isFinite(asked) ? new Date(asked + (input.missionId ? PARK_MISSION_MAX_MS : PARK_MAX_MS)).toISOString() : null;
  const interactive = input.runner === INTERACTIVE_WORKER_RUNNER;
  const action: ExpiryAction = input.deliveryId
    ? 'delivery'
    : interactive && input.missionExecutor !== 'local'
      ? 'ends'
      : input.recommended ? 'default' : 'restart';
  return { expiresAt, onExpiry: { action, option: action === 'default' ? input.recommended : null } };
}

/** Repo paths overlap when one is the other or a directory above it. */
function pathsTouch(a: string, b: string): boolean {
  const x = a.replace(/\/+$/, '');
  const y = b.replace(/\/+$/, '');
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * The outcome-spec criteria a task supplies evidence for (R-2), within the
 * mission's in-scope criteria (narrowed, less waived):
 *  - the mission's acceptance-tests or final verification task: all of them;
 *  - a task pinned to the spec (`context.specSource`): the ones it names, or all;
 *  - otherwise the criteria whose recorded tests (`verified_by`, keyed by
 *    criterion) sit on paths the task declares.
 */
export function affectedCriteria(input: {
  entry: LivingSpecGoalCriterion;
  criterionIds: readonly string[];
  verifiedBy: SpecRow['verifiedBy'];
  context: unknown;
  pathManifest: readonly string[] | null;
  missionId: string;
}): { affected: string[]; total: number } | null {
  const waived = new Set((input.entry.waived ?? []).map(w => w.criterionId));
  const inScope = (input.entry.criteria?.length ? input.entry.criteria : input.criterionIds).filter(id => !waived.has(id));
  if (inScope.length === 0) return null;
  const ctx = (input.context && typeof input.context === 'object' ? input.context : {}) as Record<string, any>;
  const of = (ids: readonly string[]) => inScope.filter(id => ids.includes(id));
  let affected: string[] = [];
  const acceptance = ctx.acceptanceTests;
  const verification = ctx.finalVerification;
  if ((acceptance && (acceptance.specId === input.entry.specId || acceptance.missionId === input.missionId))
    || (verification && (verification.specId === input.entry.specId || verification.missionId === input.missionId))) {
    affected = [...inScope];
  } else if (ctx.specSource?.specId === input.entry.specId) {
    const named = asStrings(ctx.specSource.criteria);
    affected = named.length ? of(named) : [...inScope];
  } else if (input.verifiedBy && !Array.isArray(input.verifiedBy) && input.pathManifest?.length) {
    const paths = input.pathManifest;
    affected = inScope.filter(id => asStrings((input.verifiedBy as Record<string, unknown>)[id]).some(p => paths.some(q => pathsTouch(p, q))));
  }
  return affected.length ? { affected, total: inScope.length } : null;
}

/** The asking question's options and recommended label, from `waitingFor`. */
function questionOf(waitingFor: unknown): { options: unknown[]; recommended: string | null } {
  const wf = (waitingFor && typeof waitingFor === 'object' ? waitingFor : {}) as Record<string, any>;
  const options = Array.isArray(wf.options) ? wf.options : [];
  const flagged = options.find(o => o && typeof o === 'object' && o.recommended === true && typeof o.label === 'string');
  const recommended = typeof wf.recommended?.label === 'string' ? wf.recommended.label : flagged?.label ?? null;
  return { options, recommended };
}

/**
 * "What waits on this" for `taskId`, as `viewer` may see it. Null when the
 * task does not exist, or, with `requireQuestion`, when no question is open.
 * `worker` skips the read of the waiting worker when the caller already holds it.
 */
export async function loadQuestionWaits(
  input: { taskId: string; viewer: DependencyViewer; worker?: WaitingWorkerRow | null; now?: Date; requireQuestion?: boolean },
  io: QuestionWaitsIo = dbIo,
): Promise<QuestionWaits | null> {
  const task = await io.loadTask(input.taskId);
  if (!task) return null;
  const worker = input.worker !== undefined ? input.worker : await io.loadWaitingWorker(task.id);
  if (input.requireQuestion && !worker) return null;
  const scope = { viewer: input.viewer, teamId: task.teamId, dependentWorkspaceId: task.workspaceId };

  // Step one and two, then a count one step further: declared edges only.
  const declaredOn = (r: DependentRow, ids: ReadonlySet<string>) => r.dependsOn.some(id => ids.has(id) && !r.inferredDependsOn.includes(id));
  const stepFrom = async (from: readonly DependentRow[] | readonly string[], seen: Set<string>) => {
    const ids = new Set(from.map(f => (typeof f === 'string' ? f : f.id)));
    if (ids.size === 0) return [];
    const rows = (await io.loadDependents([...ids])).filter(r => !seen.has(r.id) && declaredOn(r, ids)).slice(0, WAITS_STEP_LIMIT);
    for (const r of rows) seen.add(r.id);
    return rows;
  };
  const seen = new Set<string>([task.id]);
  const first = await stepFrom([task.id], seen);
  const second = await stepFrom(first, seen);
  const beyond = await stepFrom(second, seen);
  const laneRows = await io.loadLaneWaits(task).catch(() => [] as LaneRow[]);

  const laneIds = laneRows.flatMap(l => l.queued.map(q => q.id));
  const reach = await io.resolve(scope, [...first, ...second].map(r => r.id).concat(laneIds)).catch(() => new Map<string, DependencyHolder>());
  const visible = (id: string) => { const h = reach.get(id); return h && !h.hidden ? h : null; };

  // Whether a depth-1 task's other dependencies are done.
  const others = [...new Set(first.flatMap(r => r.dependsOn).filter(id => id !== task.id))];
  const statuses = new Map((await io.loadStatuses(others)).map(s => [s.id, s.status]));

  const missionIds = [...new Set([task.missionId, ...[...first, ...second].filter(r => visible(r.id)).map(r => r.missionId)].filter((id): id is string => !!id))];
  const missionRows = new Map((await io.loadMissions(missionIds)).map(m => [m.id, m]));
  const missionTitle = (id: string | null) => (id ? missionRows.get(id)?.title ?? null : null);

  let hiddenCount = 0;
  const waiting: WaitingTask[] = [];
  const firstTitles = new Map<string, string>();
  for (const r of first) {
    const h = visible(r.id);
    if (!h) { hiddenCount += 1; continue; }
    firstTitles.set(r.id, r.title);
    waiting.push({
      id: r.id,
      title: r.title,
      depth: 1,
      missionId: r.missionId,
      missionTitle: missionTitle(r.missionId),
      workspaceName: h.workspaceName,
      after: null,
      alsoWaitsOnOther: r.dependsOn.some(id => id !== task.id && !r.inferredDependsOn.includes(id) && !SATISFIED.has(statuses.get(id) ?? 'pending')),
    });
  }
  for (const r of second) {
    const h = visible(r.id);
    if (!h) { hiddenCount += 1; continue; }
    const parentId = r.dependsOn.find(id => firstTitles.has(id)) ?? null;
    waiting.push({
      id: r.id,
      title: r.title,
      depth: 2,
      missionId: r.missionId,
      missionTitle: missionTitle(r.missionId),
      workspaceName: h.workspaceName,
      after: parentId ? { id: parentId, title: firstTitles.get(parentId)! } : null,
      alsoWaitsOnOther: false,
    });
  }

  const lanes: LaneWait[] = laneRows.map(l => {
    const queued = l.queued.filter(q => visible(q.id));
    return { lane: l.lane, queued, hiddenCount: l.queued.length - queued.length };
  });

  const mission = task.missionId ? missionRows.get(task.missionId) ?? null : null;
  let criteria: QuestionWaits['criteria'] = null;
  const entry = (mission?.goalCriteria ?? []).find((c): c is LivingSpecGoalCriterion => c?.type === 'living_spec' && c.role !== 'standard');
  if (mission && entry) {
    const spec = await io.loadSpec(entry.specId, entry.specRevisionId).catch(() => null);
    if (spec) {
      const hit = affectedCriteria({ entry, criterionIds: spec.criterionIds, verifiedBy: spec.verifiedBy, context: task.context, pathManifest: task.pathManifest, missionId: mission.id });
      if (hit) criteria = { specId: entry.specId, specTitle: spec.title, ...hit };
    }
  }

  const q = questionOf(worker?.waitingFor);
  const expiry = worker
    ? expiryOf({ askedAt: worker.updatedAt, missionId: task.missionId, missionExecutor: mission?.executor ?? null, runner: worker.runner, deliveryId: task.deliveryId, recommended: q.recommended })
    : { expiresAt: null, onExpiry: { action: 'restart' as const, option: null } };

  return {
    taskId: task.id,
    mission: mission ? { id: mission.id, title: mission.title } : null,
    waiting,
    hiddenCount,
    beyondCount: beyond.length,
    lanes,
    criteria,
    askedAt: worker ? new Date(worker.updatedAt).toISOString() : null,
    expiresAt: expiry.expiresAt,
    onExpiry: expiry.onExpiry,
    options: optionOutcomes(q.options as never, { waiting, hiddenCount, beyondCount: beyond.length, lanes }, q.recommended),
  };
}

/** At most this many decisions are read per page; the rest carry no waits. */
export const WAITS_PAGE_LIMIT = 12;

/**
 * The projection for each decision a page shows (Home, the mission page), by
 * task id. Never throws: a task whose read fails is left out and its card
 * shows the agent's own lines only.
 */
export async function loadQuestionWaitsFor(
  taskIds: readonly string[],
  viewer: DependencyViewer,
  io: QuestionWaitsIo = dbIo,
): Promise<Map<string, QuestionWaits>> {
  const ids = [...new Set(taskIds)].slice(0, WAITS_PAGE_LIMIT);
  const rows = await Promise.all(ids.map(id => loadQuestionWaits({ taskId: id, viewer }, io).catch(() => null)));
  const out = new Map<string, QuestionWaits>();
  rows.forEach((w, i) => { if (w) out.set(ids[i], w); });
  return out;
}
