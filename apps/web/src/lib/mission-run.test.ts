import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock functions for deps injected via DI (not mock.module — avoids polluting other test files)
const mockBuildMissionContext = mock(() => Promise.resolve(null as any));
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockGetOrCreateCoordinationWorkspace = mock(() => Promise.resolve({ id: 'orchestrator-ws' }));

// Only mock.module for DB/ORM (safe — these are universally mocked in all test files)
const mockMissionsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockInsertReturning = mock(() => [] as any[]);
const mockInsertOnConflictDoNothing = mock(() => ({ returning: mockInsertReturning }));
const mockInsertValues = mock(() => ({ onConflictDoNothing: mockInsertOnConflictDoNothing }));
const mockInsert = mock(() => ({ values: mockInsertValues }));
const mockSelectResult = mock(() => Promise.resolve([] as any[]));
const mockSelectLimit = mock(() => mockSelectResult());
const mockSelectOrderBy = mock(() => ({ limit: mockSelectLimit }));
const mockSelectGroupBy = mock(() => ({ orderBy: mockSelectOrderBy }));
const mockSelectWhere = mock(() => ({ groupBy: mockSelectGroupBy }));
const mockSelectFrom = mock(() => ({ where: mockSelectWhere }));
const mockSelect = mock(() => ({ from: mockSelectFrom }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: mockInsert,
    select: mockSelect,
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  not: (arg: any) => ({ arg, type: 'not' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }), {
    raw: (s: string) => s,
  }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id' },
  tasks: { id: 'id', workspaceId: 'workspaceId', roleSlug: 'roleSlug', mode: 'mode', missionId: 'missionId', status: 'status', createdAt: 'createdAt', scheduleId: 'scheduleId' },
  workspaces: { id: 'id' },
}));

import { runMission } from './mission-run';

const deps = {
  buildMissionContext: mockBuildMissionContext as any,
  dispatchNewTask: mockDispatchNewTask as any,
  getOrCreateCoordinationWorkspace: mockGetOrCreateCoordinationWorkspace as any,
};

describe('runMission', () => {
  beforeEach(() => {
    mockMissionsFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockInsert.mockReset();
    mockInsertValues.mockReset();
    mockInsertOnConflictDoNothing.mockReset();
    mockInsertReturning.mockReset();
    mockBuildMissionContext.mockReset();
    mockDispatchNewTask.mockReset();
    mockGetOrCreateCoordinationWorkspace.mockReset();
    mockGetOrCreateCoordinationWorkspace.mockResolvedValue({ id: 'orchestrator-ws' });

    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockReturnValue({ onConflictDoNothing: mockInsertOnConflictDoNothing });
    mockInsertOnConflictDoNothing.mockReturnValue({ returning: mockInsertReturning });
    // Default: no in-flight planning task (dedupe miss)
    mockTasksFindFirst.mockResolvedValue(null);
  });

  it('throws when mission not found', async () => {
    mockMissionsFindFirst.mockResolvedValue(null);
    await expect(runMission('nonexistent', undefined, deps)).rejects.toThrow('Mission not found');
  });

  it('throws when mission is not active', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'paused',
      title: 'Test',
      schedule: null,
    });
    await expect(runMission('obj-1', undefined, deps)).rejects.toThrow('Cannot run mission with status: paused');
  });

  it('creates planning task with orchestrator creationSource', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'My Mission',
      priority: 5,
      schedule: null,
    });

    mockBuildMissionContext.mockResolvedValue({
      description: '## Mission: My Mission',
      context: { missionId: 'obj-1', missionTitle: 'My Mission' },
    });

    const createdTask = {
      id: 'task-1',
      title: 'Mission: My Mission',
      workspaceId: 'ws-1',
      status: 'pending',
      mode: 'planning',
      missionId: 'obj-1',
    };
    mockInsertReturning.mockResolvedValue([createdTask]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'Test WS' });

    const result = await runMission('obj-1', undefined, deps);

    expect(result.task.id).toBe('task-1');
    expect(result.task.mode).toBe('planning');

    // Verify task was inserted with correct values
    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertCall.creationSource).toBe('orchestrator');
    expect(insertCall.missionId).toBe('obj-1');
    expect(insertCall.mode).toBe('planning');

    // Verify dispatch was called
    expect(mockDispatchNewTask).toHaveBeenCalledWith(createdTask, { id: 'ws-1', name: 'Test WS' });
  });

  it('runs the planning task on the mission default backend when set', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'Codex Mission',
      priority: 0,
      defaultBackend: 'codex',
      schedule: null,
    });
    mockBuildMissionContext.mockResolvedValue({ description: 'x', context: {} });
    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'Test WS' });

    await runMission('obj-1', undefined, deps);

    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertCall.backend).toBe('codex');
  });

  it('omits backend on the planning task when the mission has none', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'Default Mission',
      priority: 0,
      schedule: null,
    });
    mockBuildMissionContext.mockResolvedValue({ description: 'x', context: {} });
    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'Test WS' });

    await runMission('obj-1', undefined, deps);

    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertCall.backend).toBeUndefined();
  });

  it('sets manualRun in context when option is true', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'My Mission',
      priority: 0,
      schedule: null,
    });

    mockBuildMissionContext.mockResolvedValue({
      description: '## Mission',
      context: { missionId: 'obj-1' },
    });

    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });

    await runMission('obj-1', { manualRun: true }, deps);

    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect((insertCall.context as any).manualRun).toBe(true);
  });

  it('does not set manualRun when option is omitted', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'My Mission',
      priority: 0,
      schedule: null,
    });

    mockBuildMissionContext.mockResolvedValue({
      description: '## Mission',
      context: { missionId: 'obj-1' },
    });

    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });

    await runMission('obj-1', undefined, deps);

    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect((insertCall.context as any).manualRun).toBeUndefined();
  });

  it('includes cycle context in task context', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'My Mission',
      priority: 0,
      schedule: null,
    });

    mockBuildMissionContext.mockResolvedValue({
      description: '## Mission',
      context: { missionId: 'obj-1' },
    });

    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });

    await runMission('obj-1', undefined, deps);

    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    const ctx = insertCall.context as Record<string, unknown>;
    expect(ctx.cycleNumber).toBe(1);
    expect(ctx.triggerChainId).toBeDefined();
    expect(ctx.triggerSource).toBe('manual');
  });

  it('propagates provided cycle context', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'My Mission',
      priority: 0,
      schedule: null,
    });

    mockBuildMissionContext.mockResolvedValue({
      description: '## Mission',
      context: { missionId: 'obj-1' },
    });

    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });

    await runMission('obj-1', {
      cycleContext: { cycleNumber: 3, triggerChainId: 'chain-abc', triggerSource: 'retrigger' },
    }, deps);

    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    const ctx = insertCall.context as Record<string, unknown>;
    expect(ctx.cycleNumber).toBe(3);
    expect(ctx.triggerChainId).toBe('chain-abc');
    expect(ctx.triggerSource).toBe('retrigger');
  });

  it('returns existing in-flight planning task when one exists (dedupe)', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'Mission',
      priority: 0,
      schedule: null,
    });

    const existing = {
      id: 'task-existing',
      title: 'Mission: Mission',
      workspaceId: 'ws-1',
      status: 'in_progress',
      mode: 'planning',
      missionId: 'obj-1',
    };
    mockTasksFindFirst.mockResolvedValue(existing);

    const result = await runMission('obj-1', { manualRun: true }, deps);

    expect(result.deduped).toBe(true);
    expect(result.task.id).toBe('task-existing');
    // Must not create a new task
    expect(mockInsert).not.toHaveBeenCalled();
    // Must not dispatch
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });

  it('dedupes against a cron-created schedule task when mission has a scheduleId', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'Heartbeat Mission',
      priority: 0,
      scheduleId: 'sched-1', // mission has a linked schedule
      schedule: { taskTemplate: { context: { heartbeat: true } } },
    });

    const cronTask = {
      id: 'cron-task-1',
      title: 'Heartbeat Mission',
      workspaceId: 'ws-1',
      status: 'in_progress',
      mode: 'execution', // cron creates execution tasks, not planning
      missionId: 'obj-1',
      scheduleId: 'sched-1',
    };

    // First findFirst call: no in-flight planning task
    // Second findFirst call: cron task is active for this schedule
    mockTasksFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(cronTask);

    const result = await runMission('obj-1', { manualRun: true }, deps);

    expect(result.deduped).toBe(true);
    expect(result.task.id).toBe('cron-task-1');
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });

  it('auto-creates coordination workspace when mission has no workspaceId', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: null,
      status: 'active',
      title: 'No WS Mission',
      priority: 0,
      schedule: null,
    });

    mockBuildMissionContext.mockResolvedValue({
      description: '## Mission',
      context: { missionId: 'obj-1' },
    });

    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'orchestrator-ws' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'orchestrator-ws', name: '__coordination' });

    await runMission('obj-1', undefined, deps);

    expect(mockGetOrCreateCoordinationWorkspace).toHaveBeenCalledWith('team-1');

    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertCall.workspaceId).toBe('orchestrator-ws');
  });

  it('deduplicates atomically when two concurrent callers race past the dedup check', async () => {
    // Scenario: both callers read "no in-flight task" simultaneously (race window),
    // then both attempt to insert. The second insert hits the unique constraint and
    // returns nothing — runMission should fetch the winner's task and return deduped:true.
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'Race Mission',
      priority: 0,
      schedule: null,
    });

    mockBuildMissionContext.mockResolvedValue({
      description: '## Mission',
      context: { missionId: 'obj-1' },
    });

    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });

    const winnerTask = {
      id: 'task-winner',
      title: 'Mission: Race Mission',
      workspaceId: 'ws-1',
      status: 'pending',
      mode: 'planning',
      missionId: 'obj-1',
    };

    // Initial dedup check: both callers see no in-flight task (race window)
    mockTasksFindFirst.mockResolvedValueOnce(null);
    // Fallback fetch after conflict: returns the winner's task
    mockTasksFindFirst.mockResolvedValueOnce(winnerTask);

    // Insert returns empty: unique constraint fired (loser path)
    mockInsertReturning.mockResolvedValue([]);

    const result = await runMission('obj-1', undefined, deps);

    expect(result.deduped).toBe(true);
    expect(result.task?.id).toBe('task-winner');
    // Dispatch must NOT be called for the loser path
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });
});
