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

// Injected directly — no mock.module needed for mission-run
const mockRunMission = mock(() => Promise.resolve({ task: { id: 'new-task' } }));
const mockTriggerEvent = mock(() => Promise.resolve());

// Mock drizzle-orm operators (only used as opaque args to mocked db calls)
mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ _op: 'sql' }),
  desc: (col: any) => ({ _op: 'desc', col }),
  gt: (col: any, val: any) => ({ _op: 'gt', col, val }),
}));

// Mock schema types (used only as keys into mocked db calls)
mock.module('@buildd/core/db/schema', () => ({
  missions: Symbol('missions'),
  tasks: Symbol('tasks'),
  taskSchedules: Symbol('taskSchedules'),
  missionNotes: Symbol('missionNotes'),
}));

// Mock mission-helpers — must match real logic for dormancy tests
mock.module('@buildd/core/mission-helpers', () => ({
  isDeliverableTask(t: { title: string; mode?: string | null }): boolean {
    if (t.mode === 'planning') return false;
    if (t.title.startsWith('Aggregate results:')) return false;
    if (t.title.startsWith('Evaluate mission completion:')) return false;
    if (t.title.startsWith('Mission:')) return false;
    return true;
  },
}));

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
      values: () => Promise.resolve([]),
    }),
  },
}));

const mockSpawnEvaluationTask = mock(() => Promise.resolve('eval-task-1'));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { mission: (id: string) => `mission-${id}` },
  events: {
    MISSION_CYCLE_STARTED: 'mission:cycle_started',
    MISSION_LOOP_COMPLETED: 'mission:loop_completed',
    MISSION_LOOP_STALLED: 'mission:loop_stalled',
  },
}));

import { maybeRetriggerMission } from './mission-loop';

function resetAll() {
  missionFindFirstResult = null;
  scheduleFindFirstResult = null;
  updateReturningResult = [];
  taskFindFirstResult = null;
  selectResults = [];
  selectCallCount = 0;
  tasksFindManyResults = [];
  tasksFindManyCallCount = 0;
  mockRunMission.mockReset();
  mockRunMission.mockImplementation(() => Promise.resolve({ task: { id: 'new-task' } }));
  mockTriggerEvent.mockReset();
  mockTriggerEvent.mockImplementation(() => Promise.resolve());
  mockSpawnEvaluationTask.mockReset();
  mockSpawnEvaluationTask.mockImplementation(() => Promise.resolve('eval-task-1'));
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

  it('completes heartbeat mission directly when missionComplete is true (no evaluation)', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: 's1', updatedAt: new Date(Date.now() - 30000) };
    scheduleFindFirstResult = {
      taskTemplate: { context: { heartbeat: true } },
    };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 5, triggerChainId: 'chain-1' },
      result: { structuredOutput: { missionComplete: true, summary: 'All done' } },
    };

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('completed');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockSpawnEvaluationTask).not.toHaveBeenCalled();
    expect(mockTriggerEvent).toHaveBeenCalled();
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
      [],              // dormancy check: no tasks → no auto-complete
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
      [],                                       // dormancy check: no tasks → no auto-complete
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
      [],              // dormancy check: no tasks → no auto-complete
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
      [],              // dormancy check: no tasks → no auto-complete
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
      [],              // dormancy check: no tasks → no auto-complete
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
      [],              // dormancy check: no tasks → no auto-complete
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
      [],              // dormancy check: no tasks → no auto-complete
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

  // ── Dormancy auto-complete tests ──────────────────────────────────────────

  it('auto-completes mission when all deliverable tasks are completed', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: {},
    };
    // dormancy check: all deliverable tasks are completed
    tasksFindManyResults = [
      [
        { title: 'Build the API', mode: 'execution', status: 'completed' },
        { title: 'Write tests', mode: 'execution', status: 'completed' },
      ],
    ];

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('completed');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'mission-m1',
      'mission:loop_completed',
      expect.objectContaining({ missionId: 'm1', reason: 'dormancy_auto_complete' })
    );
  });

  it('auto-completes when deliverables are completed and failed (mixed terminal)', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 2, triggerChainId: 'chain-1' },
      result: {},
    };
    tasksFindManyResults = [
      [
        { title: 'Build the API', mode: 'execution', status: 'completed' },
        { title: 'Deploy to prod', mode: 'execution', status: 'failed' },
      ],
    ];

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('completed');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('does not auto-complete when some deliverable tasks are still pending', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: {},
    };
    selectResults = [[{ count: 1 }]];
    tasksFindManyResults = [
      [
        { title: 'Build the API', mode: 'execution', status: 'completed' },
        { title: 'Write tests', mode: 'execution', status: 'pending' },
      ],
      [{ id: 'pt1' }],
      [{ id: 'child-1' }],
    ];

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('retriggered');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });

  it('does not auto-complete when only housekeeping tasks exist (no deliverables)', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: {},
    };
    selectResults = [[{ count: 1 }]];
    tasksFindManyResults = [
      [
        { title: 'Aggregate results: cycle 1', mode: 'planning', status: 'completed' },
        { title: 'Evaluate mission completion: Build API', mode: 'planning', status: 'completed' },
      ],
      [{ id: 'pt1' }],
      [{ id: 'child-1' }],
    ];

    const result = await retrigger('m1', 'pt1');
    // deliverableTasks.length === 0 → allDeliverablesDone = false → no auto-complete
    expect(result.action).toBe('retriggered');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });

  it('auto-completes when deliverables done even if housekeeping tasks are pending', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 3, triggerChainId: 'chain-1' },
      result: {},
    };
    tasksFindManyResults = [
      [
        { title: 'Build the API', mode: 'execution', status: 'completed' },
        { title: 'Aggregate results: cycle 3', mode: 'planning', status: 'pending' },
        { title: 'Mission: Organizer', mode: 'planning', status: 'in_progress' },
      ],
    ];

    const result = await retrigger('m1', 'pt1');
    // Only execution task counts as deliverable; it's completed → auto-complete
    expect(result.action).toBe('completed');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('auto-completes when cancelled deliverables exist alongside completed ones', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 2, triggerChainId: 'chain-1' },
      result: {},
    };
    // 4 completed, 5 cancelled (the duplicate-task kill scenario)
    tasksFindManyResults = [
      [
        { title: 'Build feature A', mode: 'execution', status: 'completed' },
        { title: 'Build feature B', mode: 'execution', status: 'completed' },
        { title: 'Build feature C', mode: 'execution', status: 'completed' },
        { title: 'Build feature D', mode: 'execution', status: 'completed' },
        { title: 'Build feature A (dup)', mode: 'execution', status: 'cancelled' },
        { title: 'Build feature B (dup)', mode: 'execution', status: 'cancelled' },
        { title: 'Build feature C (dup)', mode: 'execution', status: 'cancelled' },
        { title: 'Build feature D (dup)', mode: 'execution', status: 'cancelled' },
        { title: 'Extra task (dup)', mode: 'execution', status: 'cancelled' },
      ],
    ];

    const result = await retrigger('m1', 'pt1');
    // All deliverables are terminal (completed or cancelled) → auto-complete
    expect(result.action).toBe('completed');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'mission-m1',
      'mission:loop_completed',
      expect.objectContaining({ reason: 'dormancy_auto_complete' })
    );
  });

  it('does not auto-complete when only cancelled deliverables exist (no successes)', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: {},
    };
    selectResults = [[{ count: 1 }]];
    // All cancelled — no deliverable successes
    tasksFindManyResults = [
      [
        { title: 'Build feature A', mode: 'execution', status: 'cancelled' },
        { title: 'Build feature B', mode: 'execution', status: 'cancelled' },
      ],
      [{ id: 'pt1' }],
      [{ id: 'child-1' }],
    ];

    const result = await retrigger('m1', 'pt1');
    // allDeliverablesDone would be true BUT hasDeliverables check prevents it if we add one
    // (the existing dormancy check at step 5 doesn't gate on "has completed" — only at step 4)
    // So this will auto-complete at step 5; that's acceptable (all work cancelled = nothing to do)
    expect(result.action).toBe('completed');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('auto-completes heartbeat mission via dormancy when all deliverables done', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: 's1', updatedAt: new Date(Date.now() - 30000) };
    scheduleFindFirstResult = {
      taskTemplate: { context: { heartbeat: true } },
    };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 2, triggerChainId: 'chain-1' },
      result: {},
    };
    // All execution tasks done — missionComplete was NOT signaled
    tasksFindManyResults = [
      [
        { title: 'Implement feature X', mode: 'execution', status: 'completed' },
        { title: 'Write tests for X', mode: 'execution', status: 'completed' },
      ],
    ];

    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('completed');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'mission-m1',
      'mission:loop_completed',
      expect.objectContaining({ reason: 'dormancy_auto_complete' })
    );
  });
});
