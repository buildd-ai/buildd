import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * `approvePlan` resolves a plan step's `baseBranch` ref into the branch name of
 * the dependency task. That name must be the branch that will ACTUALLY exist —
 * the claim route is the only thing that names a task's branch, and the runner
 * fetches `origin/<baseBranch>` and degrades (fresh start from the default
 * branch) when it is absent.
 *
 * The original implementation hand-mirrored the claim route's generator and
 * drifted from it (P8): it omitted `useBuildBranch`, and it never read the real
 * branch (`workers.branch`) or the shared mission branch (`context.headBranch`,
 * seeded from `missions.workingBranch`) — so it predicted refs that never exist.
 */

// ── Mock state ────────────────────────────────────────────────────────────────
let planningTaskRow: any = null;
let workspaceRow: any = null;
/** The mission row, when the planning task belongs to one (Option A′ opt-in). */
let missionRow: any = null;
/** id → task row, consulted by db.query.tasks.findFirst via the eq() id arg. */
let taskRows: Record<string, any> = {};
/** taskId → worker row, consulted by db.query.workers.findFirst. */
let workerRows: Record<string, any> = {};
/** plan-step index → context to persist on the created row (emulates a stamp). */
let contextSeeds: Record<number, any> = {};
let childrenRows: any[] = [];
const insertedValues: any[] = [];
const updateCalls: { id: string; set: any }[] = [];

let nextIdN = 0;
const NEXT_IDS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'bbbbbbbb-0000-4000-8000-000000000002',
  'cccccccc-0000-4000-8000-000000000003',
];

mock.module('drizzle-orm', () => ({
  eq: (col: any, val: any) => ({ _op: 'eq', args: [col, val] }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  desc: (col: any) => ({ _op: 'desc', col }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'tasks.id', parentTaskId: 'tasks.parent_task_id' },
  workspaces: { id: 'workspaces.id' },
  workers: { taskId: 'workers.task_id', createdAt: 'workers.created_at' },
  missions: { id: 'missions.id' },
}));

/** Pull the value side of an `eq(col, value)` predicate (possibly inside and()). */
function eqValue(where: any): string | undefined {
  if (!where) return undefined;
  if (where._op === 'eq') return where.args[1];
  if (where._op === 'and') {
    for (const part of where.args) {
      const v = eqValue(part);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findFirst: (args: any) => {
          const id = eqValue(args?.where);
          return Promise.resolve(id ? taskRows[id] : undefined);
        },
        findMany: () => Promise.resolve(childrenRows),
      },
      workspaces: { findFirst: () => Promise.resolve(workspaceRow) },
      missions: { findFirst: () => Promise.resolve(missionRow) },
      workers: {
        findFirst: (args: any) => {
          const taskId = eqValue(args?.where);
          return Promise.resolve(taskId ? workerRows[taskId] : undefined);
        },
      },
    },
    insert: () => ({
      values: (v: any) => {
        const index = insertedValues.length;
        insertedValues.push(v);
        const id = NEXT_IDS[nextIdN++] ?? `dddddddd-0000-4000-8000-00000000000${nextIdN}`;
        const row = { ...v, id, context: contextSeeds[index] ?? v.context };
        taskRows[id] = row;
        return { returning: () => Promise.resolve([row]) };
      },
    }),
    update: () => ({
      set: (data: any) => ({
        where: (w: any) => {
          updateCalls.push({ id: eqValue(w)!, set: data });
          return Promise.resolve();
        },
      }),
    }),
  },
}));

import { approvePlan } from './approve-plan';

const PLANNING_TASK_ID = 'eeeeeeee-0000-4000-8000-00000000000f';
const DEP_ID8 = NEXT_IDS[0].substring(0, 8);

function reset() {
  nextIdN = 0;
  taskRows = {};
  workerRows = {};
  contextSeeds = {};
  childrenRows = [];
  insertedValues.length = 0;
  updateCalls.length = 0;
  planningTaskRow = { id: PLANNING_TASK_ID, workspaceId: 'ws-1', missionId: null };
  workspaceRow = { gitConfig: null };
  missionRow = null;
  taskRows[PLANNING_TASK_ID] = planningTaskRow;
}

/** Two-step plan: `build` stacks on top of `schema`. */
const PLAN = [
  { ref: 'schema', title: 'Add schema migration' },
  { ref: 'build', title: 'Wire the UI', baseBranch: 'schema', dependsOn: ['schema'] },
];

/** The `baseBranch` approvePlan wrote onto the dependent (second) task. */
function writtenBaseBranch(): string | undefined {
  const call = updateCalls.find(c => c.id === NEXT_IDS[1] && c.set?.context);
  return call?.set?.context?.baseBranch;
}

describe('approvePlan — baseBranch resolution', () => {
  beforeEach(reset);

  it('uses the claim route generator shape for a plain workspace (no gitConfig)', async () => {
    await approvePlan(PLANNING_TASK_ID, PLAN as any);
    expect(writtenBaseBranch()).toBe(`buildd/${DEP_ID8}-add-schema-migration`);
  });

  it('honours branchingStrategy=none', async () => {
    workspaceRow = { gitConfig: { branchingStrategy: 'none' } };
    await approvePlan(PLANNING_TASK_ID, PLAN as any);
    expect(writtenBaseBranch()).toBe(`task-${DEP_ID8}`);
  });

  it('honours a custom branchPrefix', async () => {
    workspaceRow = { gitConfig: { branchPrefix: 'agent/' } };
    await approvePlan(PLANNING_TASK_ID, PLAN as any);
    expect(writtenBaseBranch()).toBe(`agent/${DEP_ID8}-add-schema-migration`);
  });

  it('keeps dependsOn resolution working alongside baseBranch', async () => {
    await approvePlan(PLANNING_TASK_ID, PLAN as any);
    const call = updateCalls.find(c => c.id === NEXT_IDS[1]);
    expect(call?.set?.dependsOn).toEqual([NEXT_IDS[0]]);
  });

  // ── Defect P8 ──────────────────────────────────────────────────────────────

  it('honours useBuildBranch, which outranks branchPrefix in the claim route', async () => {
    // The claim route checks useBuildBranch BEFORE branchPrefix, so this
    // workspace's task branches are `buildd/...`, never `agent/...`.
    workspaceRow = { gitConfig: { branchPrefix: 'agent/', useBuildBranch: true } };
    await approvePlan(PLANNING_TASK_ID, PLAN as any);
    expect(writtenBaseBranch()).toBe(`buildd/${DEP_ID8}-add-schema-migration`);
  });

  it('reads workers.branch when the dependency already has a worker', async () => {
    // A worker row carries the branch that was actually checked out — which the
    // claim route may have resolved to a shared or suffixed name. Never predict
    // over an observed value.
    workerRows[NEXT_IDS[0]] = { branch: 'mission/checkout-arc-1a2b3c4d' };
    await approvePlan(PLANNING_TASK_ID, PLAN as any);
    expect(writtenBaseBranch()).toBe('mission/checkout-arc-1a2b3c4d');
  });

  it('reads the shared mission branch off the dependency context (headBranch)', async () => {
    // A mission task whose context carries headBranch (seeded from
    // missions.workingBranch) is claimed onto THAT branch verbatim — the
    // generator is not consulted at all.
    planningTaskRow = { id: PLANNING_TASK_ID, workspaceId: 'ws-1', missionId: 'm-1' };
    taskRows[PLANNING_TASK_ID] = planningTaskRow;
    contextSeeds[0] = { headBranch: 'mission/delivery-arc-1a2b3c4d' };
    await approvePlan(PLANNING_TASK_ID, PLAN as any);
    expect(writtenBaseBranch()).toBe('mission/delivery-arc-1a2b3c4d');
  });
});

describe('approvePlan — Option A′ integration branch as the default base', () => {
  beforeEach(reset);

  /** The `context` approvePlan INSERTED for a plan step (first pass). */
  function insertedContext(index: number): Record<string, unknown> {
    return insertedValues[index]?.context ?? {};
  }

  it('does not touch the context of a mission that has not opted in', async () => {
    // The whole safety argument for shipping A′ one mission at a time: with the
    // flag off, the children this creates are indistinguishable from before the
    // feature existed. Asserting the ABSENCE of the key, not just a value.
    planningTaskRow = { id: PLANNING_TASK_ID, workspaceId: 'ws-1', missionId: 'm-1' };
    taskRows[PLANNING_TASK_ID] = planningTaskRow;
    missionRow = { workingBranch: 'mission/delivery-arc-1a2b3c4d', integrationBranchEnabled: false };
    await approvePlan(PLANNING_TASK_ID, [{ ref: 'solo', title: 'Do the thing' }] as any);
    expect('baseBranch' in insertedContext(0)).toBe(false);
  });

  it('bases every child on the integration branch when the mission opted in', async () => {
    planningTaskRow = { id: PLANNING_TASK_ID, workspaceId: 'ws-1', missionId: 'm-1' };
    taskRows[PLANNING_TASK_ID] = planningTaskRow;
    missionRow = { workingBranch: 'mission/delivery-arc-1a2b3c4d', integrationBranchEnabled: true };
    await approvePlan(
      PLANNING_TASK_ID,
      [{ ref: 'a', title: 'First' }, { ref: 'b', title: 'Second' }] as any,
    );
    expect(insertedContext(0).baseBranch).toBe('mission/delivery-arc-1a2b3c4d');
    expect(insertedContext(1).baseBranch).toBe('mission/delivery-arc-1a2b3c4d');
  });

  it('lets an explicit stacked baseBranch still win over the integration branch', async () => {
    // A step naming a predecessor is stacking deliberately. A′ only fills in the
    // base for steps that named none — it must not flatten a declared chain.
    planningTaskRow = { id: PLANNING_TASK_ID, workspaceId: 'ws-1', missionId: 'm-1' };
    taskRows[PLANNING_TASK_ID] = planningTaskRow;
    missionRow = { workingBranch: 'mission/delivery-arc-1a2b3c4d', integrationBranchEnabled: true };
    await approvePlan(PLANNING_TASK_ID, PLAN as any);
    expect(writtenBaseBranch()).toBe(`buildd/${DEP_ID8}-add-schema-migration`);
  });

  it('ignores the flag when the mission has no working branch yet', async () => {
    // Opt-in can precede the organizer's first pass, which is what generates
    // the branch name. An empty base is not a base.
    planningTaskRow = { id: PLANNING_TASK_ID, workspaceId: 'ws-1', missionId: 'm-1' };
    taskRows[PLANNING_TASK_ID] = planningTaskRow;
    missionRow = { workingBranch: null, integrationBranchEnabled: true };
    await approvePlan(PLANNING_TASK_ID, [{ ref: 'solo', title: 'Do the thing' }] as any);
    expect('baseBranch' in insertedContext(0)).toBe(false);
  });
});
