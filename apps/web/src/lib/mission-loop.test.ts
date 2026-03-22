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
            const idx = updateReturningResult.length > 0
              ? updateReturningResult.splice(0, 1)
              : [undefined];
            return Promise.resolve(idx[0] !== undefined ? [idx[0]] : []);
          },
        }),
      }),
    }),
  },
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { mission: (id: string) => `mission-${id}` },
  events: {
    MISSION_CYCLE_STARTED: 'mission:cycle_started',
    MISSION_LOOP_COMPLETED: 'mission:loop_completed',
    MISSION_LOOP_STALLED: 'mission:loop_stalled',
  },
}));

mock.module('@/lib/mission-run', () => ({
  runMission: mockRunMission,
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
}

describe('mission-loop', () => {
  beforeEach(resetAll);

  it('skips when mission is not found', async () => {
    missionFindFirstResult = null;
    const result = await maybeRetriggerMission('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('skips when mission status is not active', async () => {
    missionFindFirstResult = { id: 'm1', status: 'completed', scheduleId: null, updatedAt: new Date() };
    const result = await maybeRetriggerMission('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('skips for heartbeat missions', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: 's1', updatedAt: new Date() };
    scheduleFindFirstResult = {
      taskTemplate: { context: { heartbeat: true } },
    };
    const result = await maybeRetriggerMission('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('skips non-heartbeat scheduled missions proceed normally', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: 's1', updatedAt: new Date(Date.now() - 30000) };
    scheduleFindFirstResult = {
      taskTemplate: { context: { someFlag: true } },
    };
    // Debounce passes
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: {},
    };
    // Depth check passes
    selectResults = [[{ count: 1 }]];
    // Stall check: 1 recent planning task with children
    tasksFindManyResults = [
      [{ id: 'pt1' }],   // recent planning tasks
      [{ id: 'child1' }], // pt1 has children (not stalled)
    ];

    const result = await maybeRetriggerMission('m1', 'pt1');
    expect(result.action).toBe('retriggered');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });

  it('skips when debounce window has not passed (idempotency)', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date() };
    // Atomic update returns empty (debounce window not passed)
    updateReturningResult = [];
    const result = await maybeRetriggerMission('m1', 'pt1');
    expect(result.action).toBe('skipped');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('detects auto-completion from missionComplete in result', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    // Debounce passes
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 2, triggerChainId: 'chain-1' },
      result: { missionComplete: true },
    };

    const result = await maybeRetriggerMission('m1', 'pt1');
    expect(result.action).toBe('completed');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  it('detects auto-completion from structuredOutput.missionComplete', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 2, triggerChainId: 'chain-1' },
      result: { structuredOutput: { missionComplete: true, summary: 'All done' } },
    };

    const result = await maybeRetriggerMission('m1', 'pt1');
    expect(result.action).toBe('completed');
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('stops at depth limit (5 cycles)', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 4, triggerChainId: 'chain-1' },
      result: {},
    };
    // Depth query returns count >= 5
    selectResults = [[{ count: 5 }]];

    const result = await maybeRetriggerMission('m1', 'pt1');
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
    // Depth check passes
    selectResults = [[{ count: 3 }]];
    // findMany calls:
    // [0] recent planning tasks (2 results)
    // [1] pt-prev1 children (empty = stall)
    // [2] pt-prev2 children (empty = stall)
    tasksFindManyResults = [
      [{ id: 'pt-prev1' }, { id: 'pt-prev2' }],
      [],
      [],
    ];

    const result = await maybeRetriggerMission('m1', 'pt1');
    expect(result.action).toBe('stalled');
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  it('retriggers when all guards pass', async () => {
    missionFindFirstResult = { id: 'm1', status: 'active', scheduleId: null, updatedAt: new Date(Date.now() - 30000) };
    updateReturningResult = [{ id: 'm1' }];
    taskFindFirstResult = {
      context: { cycleNumber: 1, triggerChainId: 'chain-1' },
      result: {},
    };
    // Depth check passes
    selectResults = [[{ count: 1 }]];
    // findMany: 1 recent planning task with children
    tasksFindManyResults = [
      [{ id: 'pt1' }],
      [{ id: 'child-1' }],
    ];

    const result = await maybeRetriggerMission('m1', 'pt1');
    expect(result.action).toBe('retriggered');
    expect(mockRunMission).toHaveBeenCalledTimes(1);
    const runCall = mockRunMission.mock.calls[0];
    expect(runCall[0]).toBe('m1');
    expect((runCall[1] as any).cycleContext.cycleNumber).toBe(2);
    expect((runCall[1] as any).cycleContext.triggerSource).toBe('retrigger');
    expect((runCall[1] as any).cycleContext.triggerChainId).toBe('chain-1');
  });
});
