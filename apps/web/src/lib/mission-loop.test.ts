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

  it('skips for heartbeat missions', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: 's1', updatedAt: new Date() };
    scheduleFindFirstResult = {
      taskTemplate: { context: { heartbeat: true } },
    };
    const result = await retrigger('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
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
      [{ id: 'pt-prev1' }, { id: 'pt-prev2' }],
      [],
      [],
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
});
