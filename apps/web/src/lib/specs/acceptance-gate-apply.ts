/**
 * Acts on `decideBuildingGate` (spec 1dc6cc39 R-78, R-79).
 *
 * Where the state lives: the acceptance-tests task is the mission task whose `context.acceptanceTests`
 * is the marker object `{ missionId, specId, ... }` (the shape ensureAcceptanceTests files, and the
 * one deliverableRole reads). The tests added, with their result on the starting commit, are the
 * array in `context.acceptanceTestResults`, and, in
 * `context.acceptanceObjection`, whether the person objected. Building tasks are the mission's other
 * open tasks; the gate holds one by putting the acceptance-tests task in its `dependsOn`, which the
 * claim route already treats as "not claimable until that task completes".
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { OPEN_TASK_STATUSES, UNCLAIMED_TASK_STATUSES } from '@buildd/shared';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { decideBuildingGate, type AcceptanceTest, type GateDecision, type StartingResult } from './acceptance-gate';

export interface GateTask {
  id: string;
  status: string;
  dependsOn: string[] | null;
  context: Record<string, unknown> | null;
}

export interface GateState {
  acceptanceTask: GateTask;
  tests: AcceptanceTest[];
  objected: boolean;
  /** Open mission tasks other than the acceptance-tests task. */
  buildingTasks: GateTask[];
}

export interface GateStore {
  load(missionId: string): Promise<GateState | null>;
  /** Merge a patch into the acceptance-tests task's context. */
  patchContext(taskId: string, patch: Record<string, unknown>): Promise<void>;
  completeAcceptanceTask(taskId: string): Promise<void>;
  reopenAcceptanceTask(taskId: string): Promise<void>;
  holdBuildingTask(taskId: string, dependsOn: string[]): Promise<void>;
}

const RESULTS = new Set(['fail', 'pass', 'inconclusive']);

export const ACCEPTANCE_RESULTS_KEY = 'acceptanceTestResults';

export function isAcceptanceTask(t: { context?: Record<string, unknown> | null }): boolean {
  const marker = t.context?.acceptanceTests;
  return !!marker && typeof marker === 'object' && !Array.isArray(marker);
}

/** The tests recorded on a task's context; malformed entries are dropped. */
export function testsFromContext(context: Record<string, unknown> | null | undefined): AcceptanceTest[] {
  const raw = context?.[ACCEPTANCE_RESULTS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): AcceptanceTest[] => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    if (typeof o.checkId !== 'string' || typeof o.name !== 'string') return [];
    const startingResult = typeof o.startingResult === 'string' && RESULTS.has(o.startingResult) ? (o.startingResult as StartingResult) : null;
    return [{ checkId: o.checkId, name: o.name, startingResult, ...(typeof o.output === 'string' ? { output: o.output } : {}) }];
  });
}

export interface GateOutcome {
  decision: GateDecision['action'];
  held: string[];
}

/** Decide, then act. Idempotent: a repeat call with the same state changes nothing. */
export async function applyBuildingGate(store: GateStore, missionId: string): Promise<GateOutcome | null> {
  const state = await store.load(missionId);
  if (!state) return null;
  const decision = decideBuildingGate({ tests: state.tests, objected: state.objected });
  const acceptanceId = state.acceptanceTask.id;
  const held: string[] = [];

  if (decision.action === 'hold') {
    for (const t of state.buildingTasks) {
      const deps = t.dependsOn ?? [];
      if (deps.includes(acceptanceId)) continue;
      await store.holdBuildingTask(t.id, [...deps, acceptanceId]);
      held.push(t.id);
    }
    if (state.acceptanceTask.status !== 'pending') await store.reopenAcceptanceTask(acceptanceId);
  } else if (decision.action === 'start') {
    if (state.acceptanceTask.status !== 'completed') await store.completeAcceptanceTask(acceptanceId);
  } else {
    // Not startable yet (R-78): building waits on the acceptance-tests task, which must not read as
    // done. A test that passed on the starting commit goes back to it with its output; a check with
    // no settled run is simply not released.
    for (const t of state.buildingTasks) {
      const deps = t.dependsOn ?? [];
      if (deps.includes(acceptanceId)) continue;
      await store.holdBuildingTask(t.id, [...deps, acceptanceId]);
      held.push(t.id);
    }
    if (decision.sendBack.length > 0) await store.patchContext(acceptanceId, { acceptanceSentBack: decision.sendBack });
    if (state.acceptanceTask.status === 'completed') await store.reopenAcceptanceTask(acceptanceId);
  }
  return { decision: decision.action, held };
}

/** Record test results (matched by checkId + name; unknown ones are added), then run the gate. */
export async function recordAcceptanceResults(store: GateStore, missionId: string, results: AcceptanceTest[]): Promise<GateOutcome | null> {
  const state = await store.load(missionId);
  if (!state) return null;
  const merged = [...state.tests];
  for (const r of results) {
    const i = merged.findIndex((t) => t.checkId === r.checkId && t.name === r.name);
    if (i >= 0) merged[i] = { ...merged[i], ...r }; else merged.push(r);
  }
  await store.patchContext(state.acceptanceTask.id, { [ACCEPTANCE_RESULTS_KEY]: merged });
  return applyBuildingGate(store, missionId);
}

/** Store the person's objection (or its withdrawal) on the acceptance-tests task, then run the gate. */
export async function recordAcceptanceObjection(store: GateStore, missionId: string, objected: boolean): Promise<GateOutcome | null> {
  const state = await store.load(missionId);
  if (!state) return null;
  await store.patchContext(state.acceptanceTask.id, { acceptanceObjection: objected });
  return applyBuildingGate(store, missionId);
}

/** The gate's state from a mission's task rows, in the shape ensureAcceptanceTests files them. */
export function gateStateFromRows(rows: readonly GateTask[]): GateState | null {
  const acceptanceTask = rows.find(isAcceptanceTask);
  if (!acceptanceTask) return null;
  return {
    acceptanceTask,
    tests: testsFromContext(acceptanceTask.context),
    objected: acceptanceTask.context?.acceptanceObjection === true,
    buildingTasks: rows.filter((t) => t.id !== acceptanceTask.id && !isAcceptanceTask(t) && (UNCLAIMED_TASK_STATUSES as readonly string[]).includes(t.status)),
  };
}

export const dbGateStore: GateStore = {
  async load(missionId) {
    const rows = await db.query.tasks.findMany({
      where: sqlWhere(eq(tasks.missionId, missionId)),
      columns: { id: true, status: true, dependsOn: true, context: true },
    });
    return gateStateFromRows(rows);
  },
  async patchContext(taskId, patch) {
    const row = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, taskId)), columns: { context: true } });
    await db.update(tasks).set({ context: { ...(row?.context ?? {}), ...patch } }).where(eq(tasks.id, taskId));
  },
  async completeAcceptanceTask(taskId) {
    await db.update(tasks).set({ status: 'completed' }).where(and(eq(tasks.id, taskId), inArray(tasks.status, [...OPEN_TASK_STATUSES])));
  },
  async reopenAcceptanceTask(taskId) {
    await db.update(tasks).set({ status: 'pending', claimedBy: null, claimedAt: null }).where(eq(tasks.id, taskId));
  },
  async holdBuildingTask(taskId, dependsOn) {
    await db.update(tasks).set({ dependsOn }).where(eq(tasks.id, taskId));
  },
};
