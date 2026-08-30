import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Mock state ──
let missionFindFirstResult: any = null;
let scheduleFindFirstResult: any = null;
let updateReturningResult: any[] = [];
let taskFindFirstResult: any = null;
let selectResults: any[][] = [];
let selectCallCount = 0;
let tasksFindManyResults: any[][] = [];
let tasksFindManyCallCount = 0;
let insertedNoteData: any[] = [];

// Injected directly — no mock.module needed for mission-run
const mockRunMission = mock(() => Promise.resolve({ task: { id: 'new-task' } }));
const mockTriggerEvent = mock(() => Promise.resolve());

// Mock drizzle-orm operators (only used as opaque args to mocked db calls)
mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  or: (...args: any[]) => ({ _op: 'or', args }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ _op: 'sql', strings, values }),
    { join: (items: any[], sep: any) => ({ _op: 'sql.join', items, sep }) },
  ),
  desc: (col: any) => ({ _op: 'desc', col }),
  gt: (col: any, val: any) => ({ _op: 'gt', col, val }),
  inArray: (col: any, vals: any[]) => ({ _op: 'inArray', col, vals }),
  isNull: (col: any) => ({ _op: 'isNull', col }),
  lte: (col: any, val: any) => ({ _op: 'lte', col, val }),
  ne: (col: any, val: any) => ({ _op: 'ne', col, val }),
  asc: (col: any) => ({ _op: 'asc', col }),
}));

// Mock schema types (used only as keys into mocked db calls)
mock.module('@buildd/core/db/schema', () => ({
  missions: Symbol('missions'),
  tasks: Symbol('tasks'),
  taskSchedules: Symbol('taskSchedules'),
  missionNotes: Symbol('missionNotes'),
}));

// Uses the REAL @buildd/core/mission-helpers (isDeliverableTask) — no mock, so
// nothing leaks into later files that depend on the real rollup helpers.
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: {
        findFirst: () => Promise.resolve(missionFindFirstResult),
      },
      taskSchedules: {
        findFirst: () => Promise.resolve(scheduleFindFirstResult),
      },
      tasks: {
        findFirst: () => Promise.resolve(taskFindFirstResult),
        findMany: () => {
          const idx = tasksFindManyCallCount++;
          return Promise.resolve(tasksFindManyResults[idx] || []);
        },
      },
    },
    select: () => ({
      from: () => ({
        where: () => {
          const idx = selectCallCount++;
          return Promise.resolve(selectResults[idx] || []);
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => {
            const val = updateReturningResult.shift();
            return Promise.resolve(val !== undefined ? [val] : []);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (v: any) => { insertedNoteData.push(v); return Promise.resolve([]); },
    }),
  },
}));

// The shared completion predicate (mission-completion.ts). Mocked so these tests
// stay about the loop's control flow: which path proposes completion, and what
// the loop does with a refusal. The predicate's own rules — pending deliverables,
// infra stalls, goal criteria — are covered in mission-completion.test.ts.
type Decision = { ok: boolean; code: string; reason: string };
function decision(code: string, ok = false): Decision {
  return { ok, code, reason: `stub: ${code}` };
}
const mockCompleteMissionIfVerified = mock((_id: string, _opts: any) => Promise.resolve({
  completed: false,
  decision: decision('no_deliverables'),
}) as any);

mock.module('@/lib/mission-completion', () => ({
  completeMissionIfVerified: mockCompleteMissionIfVerified,
}));

const mockSpawnEvaluationTask = mock(() => Promise.resolve('eval-task-1'));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { mission: (id: string) => `mission-${id}` },
  events: {
    MISSION_CYCLE_STARTED: 'mission:cycle_started',
    MISSION_LOOP_COMPLETED: 'mission:loop_completed',
    MISSION_LOOP_STALLED: 'mission:loop_stalled',
    MISSION_REOPENED: 'mission:reopened',
  },
}));

import { maybeRetriggerMission, reopenCompletedMission } from './mission-loop';

function resetAll() {
  missionFindFirstResult = null;
  scheduleFindFirstResult = null;
  updateReturningResult = [];
  taskFindFirstResult = null;
  selectResults = [];
  selectCallCount = 0;
  tasksFindManyResults = [];
  tasksFindManyCallCount = 0;
  insertedNoteData = [];
  mockRunMission.mockReset();
  mockRunMission.mockImplementation(() => Promise.resolve({ task: { id: 'new-task' } }));
  mockTriggerEvent.mockReset();
  mockTriggerEvent.mockImplementation(() => Promise.resolve());
  mockSpawnEvaluationTask.mockReset();
  mockSpawnEvaluationTask.mockImplementation(() => Promise.resolve('eval-task-1'));
  mockCompleteMissionIfVerified.mockReset();
  // Default: the predicate refuses because there is nothing to complete, so the
  // loop falls through to its retrigger/stall guards.
  mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
    completed: false,
    decision: decision('no_deliverables'),
  }) as any);
}

/** Helper: call maybeRetriggerMission with injected mocks */
function retrigger(missionId: string, taskId: string) {
  return maybeRetriggerMission(missionId, taskId, mockRunMission as any, mockSpawnEvaluationTask as any);
}

describe('mission-loop', () => {
  beforeEach(resetAll);

  it('skips when mission is not found', async () => {
    missionFindFirstResult = null;
    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('skips when mission status is not active', async () => {
    missionFindFirstResult = { id: 'm1', status: 'completed', scheduleId: null, updatedAt: new Date() };
    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('skips retrigger when orchestrationMode is manual', async () => {
    missionFindFirstResult = {
      id: 'm1',
      status: 'active',
      scheduleId: null,
      updatedAt: new Date(Date.now() - 30_000),
      orchestrationMode: 'manual',
      dependsOnMissionId: null,
      gateCondition: 'merged',
      dependencyMetAt: null,
    };
    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('skips retrigger for heartbeat missions (no missionComplete)', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: 's1', updatedAt: new Date(Date.now() - 30000) };
    scheduleFindFirstResult = {
      taskTemplate: { context: { heartbeat: true } },
    };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: { structuredOutput: { missionComplete: false, summary: 'Still working' } },
    };
    // dormancy check sees no tasks → no auto-complete → falls through to heartbeat skip
    tasksFindManyResults = [[]];
    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('routes a heartbeat missionComplete through the shared predicate and completes when it agrees', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: 's1', updatedAt: new Date(Date.now() - 30000) };
    scheduleFindFirstResult = {
      taskTemplate: { context: { heartbeat: true } },
    };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 5, triggerChainId: 'chain-1' },
      result: { structuredOutput: { missionComplete: true, summary: 'All done' } },
    };
    mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
      completed: true,
      decision: decision('ok', true),
    }) as any);

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('completed');
    // The heartbeat exemption is gone: it asks, with proposed=true so a refusal
    // is surfaced instead of being silent.
    expect(mockCompleteMissionIfVerified).toHaveBeenCalledWith('m1', {
      path: 'heartbeat',
      predicate: 'task pt1 result.missionComplete=true',
      proposed: true,
    });
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockSpawnEvaluationTask).not.toHaveBeenCalled();
  });

  // ── M2 (mission 01718005): the exact sequence that closed a mission with two
  //    pending deliverables and four never-evaluated criteria. ───────────────

  it('M2: heartbeat asserts missionComplete with pending deliverables → does NOT complete', async () => {
    missionFindFirstResult = { id: 'm2', status: 'active', scheduleId: 's1', updatedAt: new Date(Date.now() - 30000) };
    scheduleFindFirstResult = { taskTemplate: { context: { heartbeat: true } } };
    updateReturningResult = [{ id: 'm2' }];
    taskFindFirstResult = {
      context: { cycleNumber: 7, triggerChainId: 'chain-1' },
      result: { structuredOutput: { missionComplete: true, summary: '6 PRs merged' } },
    };
    mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
      completed: false,
      decision: { ok: false, code: 'pending_deliverables', reason: '2 deliverable task(s) still open (2 pending)' },
    }) as any);

    const result = await retrigger('m2', 'pt1');
    expect(result.action).toBe('completion_blocked');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('M2: heartbeat asserts missionComplete with unevaluated criteria → does NOT complete', async () => {
    missionFindFirstResult = { id: 'm2', status: 'active', scheduleId: 's1', updatedAt: new Date(Date.now() - 30000) };
    scheduleFindFirstResult = { taskTemplate: { context: { heartbeat: true } } };
    updateReturningResult = [{ id: 'm2' }];
    taskFindFirstResult = {
      context: { cycleNumber: 7, triggerChainId: 'chain-1' },
      result: { structuredOutput: { missionComplete: true, summary: '6 PRs merged' } },
    };
    mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
      completed: false,
      decision: { ok: false, code: 'criteria_unverified', reason: 'Goal criteria not verified (overall: UNVERIFIED)' },
    }) as any);

    const result = await retrigger('m2', 'pt1');
    expect(result.action).toBe('completion_blocked');
  });

  it('does not skip non-heartbeat scheduled missions', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: 's1', updatedAt: new Date(Date.now() - 30000) };
    scheduleFindFirstResult = {
      taskTemplate: { context: { someFlag: true } },
    };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: {},
    };
    selectResults = [[{ count: 1 }]];
    tasksFindManyResults = [
      [{ id: 'pt1' }],
      [{ id: 'child1' }],
    ];

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('retriggered');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });

  it('skips when debounce window has not passed (idempotency)', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date() };
    updateReturningResult = [];
    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('spawns evaluation instead of completing when missionComplete in result', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 2, triggerChainId: 'chain-1' },
      result: { missionComplete: true },
    };

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('evaluation_requested');
    expect(mockSpawnEvaluationTask).toHaveBeenCalledWith('m1', 'pt1');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  it('spawns evaluation from structuredOutput.missionComplete', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 2, triggerChainId: 'chain-1' },
      result: { structuredOutput: { missionComplete: true, summary: 'All done' } },
    };

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('evaluation_requested');
    expect(mockSpawnEvaluationTask).toHaveBeenCalledWith('m1', 'pt1');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('skips when evaluation already pending (spawnEvaluationTask returns null)', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 2, triggerChainId: 'chain-1' },
      result: { missionComplete: true },
    };
    mockSpawnEvaluationTask.mockImplementation(() => Promise.resolve(null));

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('stops at depth limit (5 cycles)', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 4, triggerChainId: 'chain-1' },
      result: {},
    };
    selectResults = [[{ count: 5 }]];
    // dormancy check returns [] → no auto-complete, falls through to depth guard

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('depth_exceeded');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  it('detects stall when 2 consecutive cycles produce zero children', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 3, triggerChainId: 'chain-1' },
      result: {},
    };
    selectResults = [[{ count: 3 }]];
    tasksFindManyResults = [
      [{ id: 'pt-prev1' }, { id: 'pt-prev2' }], // stall: 2 recent planning tasks
      [],                                       // stall: no children for pt-prev1
      [],                                       // stall: no children for pt-prev2
    ];

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('stalled');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  it('requests evaluation when triageOutcome is single_task and missionComplete', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: { structuredOutput: { triageOutcome: 'single_task', tasksCreated: 1, missionComplete: true, summary: 'Routed to builder' } },
    };

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('evaluation_requested');
    expect(mockSpawnEvaluationTask).toHaveBeenCalledWith('m1', 'pt1');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('requests evaluation when triageOutcome is conflict and missionComplete', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: { structuredOutput: { triageOutcome: 'conflict', tasksCreated: 0, missionComplete: true, summary: 'Active task already covers this' } },
    };

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('evaluation_requested');
    expect(mockSpawnEvaluationTask).toHaveBeenCalledWith('m1', 'pt1');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('retriggers when triageOutcome is multi_task and missionComplete is false', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: { structuredOutput: { triageOutcome: 'multi_task', tasksCreated: 3, missionComplete: false, summary: 'Created 3 subtasks' } },
    };
    selectResults = [[{ count: 1 }]];
    tasksFindManyResults = [
      [{ id: 'pt1' }],
      [{ id: 'child-1' }, { id: 'child-2' }],
    ];

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('retriggered');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });

  it('passes stuck-planning feedback when tasksCreated is 0 in coordination workspace', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: {
        cycleNumber: 1,
        triggerChainId: 'chain-1',
        workspaceState: { name: '__coordination', repo: null, isCoordination: true, hasGitHubApp: false },
      },
      result: { structuredOutput: { triageOutcome: 'multi_task', tasksCreated: 0, missionComplete: false, summary: 'Created plan artifact' } },
    };
    selectResults = [[{ count: 1 }]];
    tasksFindManyResults = [
      [{ id: 'pt1' }],
      [{ id: 'child-1' }], // has children so stall detection passes
    ];

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('retriggered');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
    const runCall = mockRunMission.mock.calls[0];
    expect((runCall[1] as any).stuckPlanningFeedback).toContain('meta-workspace');
    expect((runCall[1] as any).stuckPlanningFeedback).toContain('manage_workspaces');
  });

  it('passes generic stuck-planning feedback when tasksCreated is 0 with repo', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: {
        cycleNumber: 1,
        triggerChainId: 'chain-1',
        workspaceState: { name: 'my-project', repo: 'https://github.com/org/repo', isCoordination: false, hasGitHubApp: true },
      },
      result: { structuredOutput: { triageOutcome: 'multi_task', tasksCreated: 0, missionComplete: false, summary: 'Analyzed' } },
    };
    selectResults = [[{ count: 1 }]];
    tasksFindManyResults = [
      [{ id: 'pt1' }],
      [{ id: 'child-1' }],
    ];

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('retriggered');
    const runCall = mockRunMission.mock.calls[0];
    expect((runCall[1] as any).stuckPlanningFeedback).toContain('concrete plan items');
  });

  it('does not pass stuck-planning feedback for conflict triage', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: {
        cycleNumber: 1,
        triggerChainId: 'chain-1',
        workspaceState: { name: '__coordination', repo: null, isCoordination: true, hasGitHubApp: false },
      },
      result: { structuredOutput: { triageOutcome: 'conflict', tasksCreated: 0, missionComplete: true, summary: 'Active task covers this' } },
    };

    const result = await retrigger('m1', 'pt1');
    // missionComplete: true → goes to evaluation, not retrigger
    expect(result.action).toBe('evaluation_requested');
  });

  it('does not pass stuck-planning feedback when tasks were created', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: { structuredOutput: { triageOutcome: 'multi_task', tasksCreated: 2, missionComplete: false, summary: 'Created 2 tasks' } },
    };
    selectResults = [[{ count: 1 }]];
    tasksFindManyResults = [
      [{ id: 'pt1' }],
      [{ id: 'child-1' }],
    ];

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('retriggered');
    const runCall = mockRunMission.mock.calls[0];
    expect((runCall[1] as any).stuckPlanningFeedback).toBeUndefined();
  });

  it('retriggers when all guards pass', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: {},
    };
    selectResults = [[{ count: 1 }]];
    tasksFindManyResults = [
      [{ id: 'pt1' }],
      [{ id: 'child-1' }],
    ];

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('retriggered');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
    const runCall = mockRunMission.mock.calls[0];
    expect(runCall[0]).toBe('m1');
    expect((runCall[1] as any).cycleContext.cycleNumber).toBe(2);
    expect((runCall[1] as any).cycleContext.triggerSource).toBe('retrigger');
    expect((runCall[1] as any).cycleContext.triggerChainId).toBe('chain-1');
  });

  // ── Dormancy: proposes, does not decide ───────────────────────────────────
  //
  // The task-shape rules (which rows are deliverables, cancelled-only missions,
  // pending CI retries, infra stalls, goal criteria) live in the shared predicate
  // and are tested in mission-completion.test.ts. What matters here is that
  // dormancy asks it, and honours the answer.

  function dormantMission() {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: {},
    };
    selectResults = [[{ count: 1 }]];
    tasksFindManyResults = [[{ id: 'pt1' }], [{ id: 'child-1' }]];
  }

  it('completes when the predicate agrees, with path=dormancy and no completion claim of its own', async () => {
    dormantMission();
    mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
      completed: true,
      decision: decision('ok', true),
    }) as any);

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('completed');
    expect(mockCompleteMissionIfVerified).toHaveBeenCalledWith('m1', { path: 'dormancy' });
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('reports completion_blocked when goal criteria are not verified — and does not retrigger planning', async () => {
    dormantMission();
    mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
      completed: false,
      decision: { ok: false, code: 'criteria_unverified', reason: 'Goal criteria not verified (overall: UNVERIFIED)' },
    }) as any);

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('completion_blocked');
    // Work is finished; more planning cycles would not help. The mission stays
    // active (awaiting verification) rather than closing or churning.
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('reports completion_blocked when a criteria verification run is still in flight', async () => {
    dormantMission();
    mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
      completed: false,
      decision: { ok: false, code: 'criteria_pending', reason: 'Goal criteria verification in flight' },
    }) as any);

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('completion_blocked');
  });

  it('reports stalled when a deliverable is infra-stalled', async () => {
    dormantMission();
    mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
      completed: false,
      decision: { ok: false, code: 'infra_stalled', reason: '1 deliverable task(s) failed on infrastructure' },
    }) as any);

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('stalled');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('falls through to retrigger when the predicate refuses for pending deliverables', async () => {
    dormantMission();
    mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
      completed: false,
      decision: { ok: false, code: 'pending_deliverables', reason: '1 deliverable task(s) still open (1 in_progress)' },
    }) as any);

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('retriggered');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });

  it('heartbeat missions do not self-retrigger after a refused dormancy check', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: 's1', updatedAt: new Date(Date.now() - 30000) };
    scheduleFindFirstResult = { taskTemplate: { context: { heartbeat: true } } };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: {},
    };
    mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
      completed: false,
      decision: { ok: false, code: 'pending_deliverables', reason: '1 deliverable task(s) still open (1 pending)' },
    }) as any);

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
  });
});

describe('reopenCompletedMission', () => {
  beforeEach(resetAll);

  it('flips a completed mission back to active and emits MISSION_REOPENED', async () => {
    // Completed mission with no schedule
    updateReturningResult = [{ id: 'm1', scheduleId: null }];

    const result = await reopenCompletedMission('m1');

    expect(result.reopened).toBe(true);
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'mission-m1',
      'mission:reopened',
      expect.objectContaining({ missionId: 'm1', reason: 'task_added' })
    );
  });

  it('re-enables the schedule when mission has one', async () => {
    // Mission has a schedule that was paused on completion
    updateReturningResult = [{ id: 'm1', scheduleId: 'sched-1' }];

    const result = await reopenCompletedMission('m1');

    expect(result.reopened).toBe(true);
    // Pusher event emitted
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'mission-m1',
      'mission:reopened',
      expect.objectContaining({ missionId: 'm1' })
    );
  });

  it('returns reopened: false when mission is not in completed state (WHERE not matched)', async () => {
    // updateReturningResult is empty → WHERE status='completed' did not match
    updateReturningResult = [];

    const result = await reopenCompletedMission('m1');

    expect(result.reopened).toBe(false);
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('regression: adding a task to a completed mission reopens it (latch fix)', async () => {
    // Simulate the bug scenario: mission was auto-completed, then a new task is added.
    // reopenCompletedMission is called from the task creation route.
    updateReturningResult = [{ id: 'a01b3251', scheduleId: 'heartbeat-sched' }];

    const result = await reopenCompletedMission('a01b3251');

    expect(result.reopened).toBe(true);
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'mission-a01b3251',
      'mission:reopened',
      expect.objectContaining({ missionId: 'a01b3251', reason: 'task_added' })
    );
  });
});
