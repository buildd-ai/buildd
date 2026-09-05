import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * Option A′ — the mission integration PR.
 *
 * Two things are worth pinning here, and they are the two that would fail
 * silently:
 *
 *  1. `evaluateMissionWorkState` must not answer "complete" over an empty set.
 *     A mission with no deliverable tasks trivially satisfies "every task is
 *     terminal and every PR merged", and a `complete` there opens a PR with no
 *     commits on it.
 *  2. The PR-merged scan must be scoped to *deliverable* tasks only. The
 *     bookkeeping row that owns the mission PR is itself a task of the mission
 *     with an unmerged PR, so including it makes the predicate wait on the very
 *     PR it is deciding whether to open — a deadlock, not a wrong number.
 *
 * The worker query's predicate is asserted directly (`inArrayValues`) rather
 * than inferred from the return value: mocking `db` makes a WHERE clause
 * unobservable, so a mis-scoped query would otherwise pass this file.
 */

let taskRowsForMission: any[] = [];
let unmergedWorkerRows: any[] = [];
/** The id list handed to `inArray(workers.taskId, …)` on the last workers query. */
let workersQueryTaskIds: string[] | null = null;

mock.module('drizzle-orm', () => ({
  eq: (col: any, val: any) => ({ _op: 'eq', args: [col, val] }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  isNull: (col: any) => ({ _op: 'isNull', col }),
  isNotNull: (col: any) => ({ _op: 'isNotNull', col }),
  inArray: (col: any, vals: any[]) => ({ _op: 'inArray', col, vals }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'tasks.id', missionId: 'tasks.mission_id' },
  workers: { taskId: 'workers.task_id', prUrl: 'workers.pr_url', mergedAt: 'workers.merged_at' },
  missions: { id: 'missions.id' },
  missionNotes: {},
  workspaces: { id: 'workspaces.id' },
  githubRepos: { id: 'github_repos.id' },
}));

/** Pull the `vals` of an inArray predicate out of a (possibly and()-wrapped) where. */
function inArrayValues(where: any): string[] | null {
  if (!where) return null;
  if (where._op === 'inArray') return where.vals;
  if (where._op === 'and') {
    for (const part of where.args) {
      const v = inArrayValues(part);
      if (v) return v;
    }
  }
  return null;
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findMany: () => Promise.resolve(taskRowsForMission) },
      workers: {
        findMany: (args: any) => {
          workersQueryTaskIds = inArrayValues(args?.where);
          return Promise.resolve(unmergedWorkerRows);
        },
        findFirst: () => Promise.resolve(null),
      },
      missions: { findFirst: () => Promise.resolve(null) },
      workspaces: { findFirst: () => Promise.resolve(null) },
      githubRepos: { findFirst: () => Promise.resolve(null) },
    },
  },
}));

mock.module('@/lib/github', () => ({ githubApi: () => Promise.resolve({}) }));

import {
  MISSION_PR_TASK_PREFIX,
  evaluateMissionWorkState,
  isMissionPrTask,
  trunkBranches,
} from './mission-pr';

const MISSION_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';

function workTask(id: string, status: string) {
  return { id, title: `Task ${id}`, status, mode: 'execution', taskClass: 'work' };
}

beforeEach(() => {
  taskRowsForMission = [];
  unmergedWorkerRows = [];
  workersQueryTaskIds = null;
});

describe('evaluateMissionWorkState', () => {
  it('is never complete for a mission with no deliverable tasks', async () => {
    // "Every task terminal, every PR merged" is vacuously true of an empty set.
    // Answering complete here opens an empty PR.
    const state = await evaluateMissionWorkState(MISSION_ID);
    expect(state.complete).toBe(false);
    expect(state.reason).toBe('no_deliverable_work');
  });

  it('is not complete when only the planning task and the PR owner exist', async () => {
    taskRowsForMission = [
      { id: 't-plan', title: 'Mission: ship it', status: 'completed', mode: 'planning', taskClass: 'bookkeeping' },
      { id: 't-own', title: `${MISSION_PR_TASK_PREFIX}ship it`, status: 'completed', mode: 'execution', taskClass: 'bookkeeping' },
    ];
    const state = await evaluateMissionWorkState(MISSION_ID);
    expect(state.reason).toBe('no_deliverable_work');
  });

  it('is not complete while a deliverable task is unfinished', async () => {
    taskRowsForMission = [workTask('t-1', 'completed'), workTask('t-2', 'in_progress')];
    const state = await evaluateMissionWorkState(MISSION_ID);
    expect(state.complete).toBe(false);
    expect(state.reason).toBe('tasks_unfinished');
    expect(state.unfinishedTaskCount).toBe(1);
  });

  it('is not complete while a deliverable PR is unmerged', async () => {
    taskRowsForMission = [workTask('t-1', 'completed')];
    unmergedWorkerRows = [{ id: 'w-1' }];
    const state = await evaluateMissionWorkState(MISSION_ID);
    expect(state.complete).toBe(false);
    expect(state.reason).toBe('prs_unmerged');
    expect(state.unmergedPrCount).toBe(1);
  });

  it('is complete when every deliverable task is terminal and every PR merged', async () => {
    taskRowsForMission = [workTask('t-1', 'completed'), workTask('t-2', 'cancelled')];
    unmergedWorkerRows = [];
    const state = await evaluateMissionWorkState(MISSION_ID);
    expect(state.complete).toBe(true);
    expect(state.reason).toBe('complete');
  });

  it('scopes the unmerged-PR scan to deliverable tasks only', async () => {
    // The load-bearing assertion. The mission-PR owner row has an unmerged PR by
    // definition; if it were in this scan the mission could never become ready
    // to open the PR that row exists to hold.
    taskRowsForMission = [
      workTask('t-1', 'completed'),
      { id: 't-plan', title: 'Mission: ship it', status: 'completed', mode: 'planning', taskClass: 'bookkeeping' },
      { id: 't-own', title: `${MISSION_PR_TASK_PREFIX}ship it`, status: 'completed', mode: 'execution', taskClass: 'bookkeeping' },
    ];
    await evaluateMissionWorkState(MISSION_ID);
    expect(workersQueryTaskIds).toEqual(['t-1']);
  });
});

describe('isMissionPrTask', () => {
  it('identifies the bookkeeping row that owns a mission PR', () => {
    expect(isMissionPrTask({ title: `${MISSION_PR_TASK_PREFIX}Ship the arc`, taskClass: 'bookkeeping' })).toBe(true);
  });

  it('rejects a work task even with a matching title', () => {
    // Both halves must hold: a planner is free to name a deliverable task
    // anything, and title alone must not confer PR ownership.
    expect(isMissionPrTask({ title: `${MISSION_PR_TASK_PREFIX}Ship the arc`, taskClass: 'work' })).toBe(false);
  });

  it('rejects other bookkeeping rows', () => {
    expect(isMissionPrTask({ title: 'Evaluate mission completion: arc', taskClass: 'bookkeeping' })).toBe(false);
    expect(isMissionPrTask({ title: 'Mission: arc', taskClass: 'bookkeeping' })).toBe(false);
  });

  it('handles a null title', () => {
    expect(isMissionPrTask({ title: null, taskClass: 'bookkeeping' })).toBe(false);
  });
});

describe('trunkBranches', () => {
  it('prefers targetBranch, then defaultBranch, then the repo default', () => {
    expect(trunkBranches({ targetBranch: 'dev', defaultBranch: 'main' }, 'master'))
      .toEqual(['dev', 'main', 'master']);
  });

  it('drops missing entries rather than emitting empties', () => {
    // An empty string in this list would make `trunk.includes('')` true and let
    // an unknown base ref claim the mission PR slot.
    expect(trunkBranches({ targetBranch: null, defaultBranch: 'main' }, null)).toEqual(['main']);
    expect(trunkBranches(null, null)).toEqual([]);
  });
});
