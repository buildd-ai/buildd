import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock functions for deps injected via DI (not mock.module — avoids polluting other test files)
const mockBuildMissionContext = mock(() => Promise.resolve(null as any));
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockGetOrCreateCoordinationWorkspace = mock(() => Promise.resolve({ id: 'orchestrator-ws' }));
const mockGetMissionSpendUsd = mock(() => Promise.resolve(0));
const mockExhaustMissionBudget = mock(() => Promise.resolve());
const mockPrepareSubjectFiling = mock(() => Promise.resolve({
  taskValues: {},
  anchor: null,
  match: null,
  warnings: [],
}) as any);
const mockRecordSubjectMatchObserved = mock(() => Promise.resolve());
const mockTriggerEvent = mock(() => Promise.resolve());

// pre-fix guard (which asked GitHub for the primary PR's state) was actually
// reachable in these tests — with the real module it returns null for a mission
// whose workspace has no installation, which would have no-opped the guard and
// made the regression tests below pass for the wrong reason. The gate no longer
// calls it; the stub stays so the replaced module keeps its full shape.
const mockGetMissionPrState = mock(() => Promise.resolve(null as any));
const mockNotifyMissionPrReady = mock(() => Promise.resolve({ notified: true }));

mock.module('@/lib/mission-notifications', () => ({
  notifyMissionPrReady: mockNotifyMissionPrReady,
}));

mock.module('@/lib/github', () => ({
  githubApi: mock(() => Promise.resolve({})),
}));

// Option A′ integration branch. Mocked because runMission's contract with it is
// only its RESULT — and the two things worth pinning here are what runMission
// does with an `ok: false` (post a blocker note, once) and with an `ok: true`
// (resolve a blocker note that is no longer true).
const mockEnsureMissionIntegrationBranch = mock(() =>
  Promise.resolve({ ok: true as const, branch: 'mission/my-mission-obj-1', created: false }) as any,
);
mock.module('@/lib/mission-integration-branch', () => ({
  ensureMissionIntegrationBranch: mockEnsureMissionIntegrationBranch,
}));

// Only mock.module for DB/ORM (safe — these are universally mocked in all test files)
const mockMissionsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => Promise.resolve([] as any[]));
const mockWorkersFindMany = mock(() => Promise.resolve([] as any[]));
const mockWorkspacesFindFirst = mock(() => null as any);
const mockMissionNotesFindFirst = mock(() => null as any);
const mockInsertReturning = mock(() => [] as any[]);
const mockInsertOnConflictDoNothing = mock(() => ({ returning: mockInsertReturning }));
const mockInsertValues = mock(() => ({ onConflictDoNothing: mockInsertOnConflictDoNothing }));
const mockInsert = mock(() => ({ values: mockInsertValues }));

// Select mock — chainable proxy so both `.where()` (direct await) and
// `.where().groupBy().orderBy().limit()` (longer chain) work correctly.
let selectCallCount = 0;
const selectResults: any[][] = [];

function makeSelectChain(p: Promise<any[]>): any {
  return new Proxy(p, {
    get(t: any, prop: string) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return t[prop].bind(t);
      return () => makeSelectChain(p);
    },
  });
}
const mockSelect = mock(() => {
  const idx = selectCallCount++;
  return makeSelectChain(Promise.resolve(selectResults[idx] ?? []));
});

/**
 * Update mock — chainable so both `.where()` (direct await) and
 * `.where().returning()` work, and RECORDING: it keeps the table, the values and
 * the predicate for every call. Recording only the values would make a guarded
 * write indistinguishable from an unguarded one.
 */
let recordedUpdates: Array<{ table: any; set: any; where: any }> = [];
let updateReturningRows: any[] = [];
function updateChain(table: any) {
  return {
    set: (vals: any) => ({
      where: (cond: any) => {
        recordedUpdates.push({ table, set: vals, where: cond });
        const p: any = Promise.resolve(updateReturningRows);
        p.returning = () => Promise.resolve(updateReturningRows);
        return p;
      },
    }),
  };
}
const mockUpdate = mock((table?: any) => updateChain(table));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      tasks: { findFirst: mockTasksFindFirst, findMany: mockTasksFindMany },
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      missionNotes: { findFirst: mockMissionNotesFindFirst },
    },
    insert: mockInsert,
    select: mockSelect,
    update: mockUpdate,
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  not: (arg: any) => ({ arg, type: 'not' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }), {
    raw: (s: string) => s,
  }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id', workingBranch: 'workingBranch' },
  tasks: { id: 'id', workspaceId: 'workspaceId', roleSlug: 'roleSlug', mode: 'mode', missionId: 'missionId', status: 'status', createdAt: 'createdAt', scheduleId: 'scheduleId', creationSource: 'creationSource', pathManifest: 'pathManifest' },
  workers: { id: 'id', taskId: 'taskId', status: 'status', prUrl: 'prUrl', prNumber: 'prNumber', mergedAt: 'mergedAt', lastCommitSha: 'lastCommitSha', prLifecycleStatus: 'prLifecycleStatus' },
  workspaces: { id: 'id' },
  missionNotes: { id: 'id', missionId: 'missionId', title: 'title', status: 'status' },
}));

import { runMission } from './mission-run';

const deps = {
  buildMissionContext: mockBuildMissionContext as any,
  dispatchNewTask: mockDispatchNewTask as any,
  getOrCreateCoordinationWorkspace: mockGetOrCreateCoordinationWorkspace as any,
  getMissionSpendUsd: mockGetMissionSpendUsd as any,
  exhaustMissionBudget: mockExhaustMissionBudget as any,
  prepareSubjectFiling: mockPrepareSubjectFiling as any,
  recordSubjectMatchObserved: mockRecordSubjectMatchObserved as any,
  triggerEvent: mockTriggerEvent as any,
};

function resetMissionRunMocks() {
    mockTriggerEvent.mockClear();
    mockMissionsFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([]);
    mockWorkersFindMany.mockReset();
    mockWorkersFindMany.mockResolvedValue([]);
    mockGetMissionPrState.mockReset();
    mockGetMissionPrState.mockResolvedValue(null);
    mockNotifyMissionPrReady.mockReset();
    mockNotifyMissionPrReady.mockResolvedValue({ notified: true });
    mockWorkspacesFindFirst.mockReset();
    mockInsert.mockReset();
    mockInsertValues.mockReset();
    mockInsertOnConflictDoNothing.mockReset();
    mockInsertReturning.mockReset();
    mockBuildMissionContext.mockReset();
    mockDispatchNewTask.mockReset();
    mockGetOrCreateCoordinationWorkspace.mockReset();
    mockGetOrCreateCoordinationWorkspace.mockResolvedValue({ id: 'orchestrator-ws' });
    mockGetMissionSpendUsd.mockReset();
    mockGetMissionSpendUsd.mockResolvedValue(0);
    mockExhaustMissionBudget.mockReset();
    mockPrepareSubjectFiling.mockReset();
    mockPrepareSubjectFiling.mockResolvedValue({
      taskValues: {},
      anchor: null,
      match: null,
      warnings: [],
    } as any);
    mockRecordSubjectMatchObserved.mockReset();
    mockRecordSubjectMatchObserved.mockResolvedValue();
    mockUpdate.mockReset();
    mockUpdate.mockImplementation((table?: any) => updateChain(table));
    recordedUpdates = [];
    updateReturningRows = [];
    mockMissionNotesFindFirst.mockReset();
    mockMissionNotesFindFirst.mockResolvedValue(null);
    mockEnsureMissionIntegrationBranch.mockReset();
    mockEnsureMissionIntegrationBranch.mockResolvedValue({
      ok: true, branch: 'mission/my-mission-obj-1', created: false,
    } as any);
    // Reset select call counter and results
    selectCallCount = 0;
    selectResults.length = 0;

    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockReturnValue({ onConflictDoNothing: mockInsertOnConflictDoNothing });
    mockInsertOnConflictDoNothing.mockReturnValue({ returning: mockInsertReturning });
    // Default: no in-flight planning task (dedupe miss)
  mockTasksFindFirst.mockResolvedValue(null);
}

describe('runMission', () => {
  beforeEach(resetMissionRunMocks);

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

  // Regression: the manual run path emitted nothing on the mission channel, so a
  // client that triggered a run had no signal to render against and the
  // orchestrator appeared to do nothing for minutes.
  it('announces the cycle on the mission channel after dispatching', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'My Mission',
      schedule: null,
    });
    mockBuildMissionContext.mockResolvedValue({ description: 'd', context: {} });
    mockInsertReturning.mockResolvedValue([{ id: 'task-1', mode: 'planning' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    await runMission('obj-1', { manualRun: true }, deps);

    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
    const [channel, event, payload] = mockTriggerEvent.mock.calls[0] as any[];
    expect(channel).toBe('mission-obj-1');
    expect(event).toBe('mission:cycle_started');
    expect(payload).toMatchObject({
      missionId: 'obj-1',
      triggerSource: 'manual',
      planningTaskId: 'task-1',
    });
  });

  it('does not announce a cycle when the run is deduped', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'My Mission',
      schedule: null,
    });
    mockTasksFindFirst.mockResolvedValue({ id: 'task-existing', mode: 'planning' });

    const result = await runMission('obj-1', { manualRun: true }, deps);

    expect(result.deduped).toBe(true);
    expect(mockTriggerEvent).not.toHaveBeenCalled();
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
    expect(mockRecordSubjectMatchObserved).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'organizer',
        match: expect.objectContaining({ taskId: 'task-existing', outcome: 'attach' }),
      }),
    );
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

  it('returns skippedBlocked when upstream dependency is not yet met', async () => {
    // First findFirst call returns the mission itself; second call (inside isMissionBlocked)
    // returns the upstream mission that is still active.
    mockMissionsFindFirst
      .mockResolvedValueOnce({
        id: 'obj-1',
        teamId: 'team-1',
        workspaceId: 'ws-1',
        status: 'active',
        title: 'Downstream Mission',
        priority: 0,
        schedule: null,
        dependsOnMissionId: 'upstream-id',
        gateCondition: 'merged',
        dependencyMetAt: null,
      })
      .mockResolvedValueOnce({
        id: 'upstream-id',
        title: 'Specs Mission',
        status: 'active',
      });

    const result = await runMission('obj-1', undefined, deps);

    expect(result.task).toBeNull();
    expect(result.skippedBlocked).toBe(true);
    expect(result.blockedReason).toContain('Specs Mission');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  // ── Pre-filed task detection (decompositionSkipped) ──

  it('detects pre-filed tasks and passes decompositionSkipped=true to buildMissionContext', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'Pre-filed Mission',
      priority: 0,
      orchestrationMode: 'auto',
      decompositionSkipped: false,
      schedule: null,
    });

    // First select call: pre-filed count (2 non-orchestrator tasks exist)
    selectResults[0] = [{ count: 2 }];
    // Second select call: dominantRole (no dominant role yet)
    selectResults[1] = [];

    mockBuildMissionContext.mockResolvedValue({ description: '## Mission', context: {} });
    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockInsertValues.mockReturnValue({ onConflictDoNothing: mockInsertOnConflictDoNothing });
    mockInsertOnConflictDoNothing.mockReturnValue({ returning: mockInsertReturning });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });

    await runMission('obj-1', undefined, deps);

    // buildMissionContext must be called with decompositionSkipped=true in templateContext
    const contextArg = mockBuildMissionContext.mock.calls[0][1] as Record<string, unknown>;
    expect(contextArg.decompositionSkipped).toBe(true);

    // db.update() must have been called to persist the flag
    expect(mockUpdate).toHaveBeenCalled();

    // A mission note must have been inserted (missionNotes insert)
    // The first db.insert() call is for missionNotes, second for tasks
    expect(mockInsert).toHaveBeenCalledTimes(2);
    const firstInsertArg = mockInsert.mock.calls[0][0];
    // missionNotes is the mock symbol from schema mock
    expect(firstInsertArg).toBeDefined();
  });

  it('does not detect pre-filed tasks when none exist — buildMissionContext gets decompositionSkipped=false/undefined', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-2',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'Empty Mission',
      priority: 0,
      orchestrationMode: 'auto',
      decompositionSkipped: false,
      schedule: null,
    });

    // First select call: pre-filed count = 0 (no pre-filed tasks)
    selectResults[0] = [{ count: 0 }];
    // Second select call: dominantRole = []
    selectResults[1] = [];

    mockBuildMissionContext.mockResolvedValue({ description: '## Mission', context: {} });
    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockInsertValues.mockReturnValue({ onConflictDoNothing: mockInsertOnConflictDoNothing });
    mockInsertOnConflictDoNothing.mockReturnValue({ returning: mockInsertReturning });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });

    await runMission('obj-2', undefined, deps);

    // buildMissionContext must NOT have decompositionSkipped=true
    const contextArg = mockBuildMissionContext.mock.calls[0][1] as Record<string, unknown>;
    expect(contextArg.decompositionSkipped).toBeFalsy();

    // db.update() must NOT be called to persist (no detection fired)
    expect(mockUpdate).not.toHaveBeenCalled();

    // Only one insert: the planning task
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('skips detection and passes decompositionSkipped=true when already persisted on mission', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-3',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'Already Skipped Mission',
      priority: 0,
      orchestrationMode: 'auto',
      decompositionSkipped: true,  // already set
      schedule: null,
    });

    // dominantRole select only (pre-filed detection is skipped)
    selectResults[0] = [];

    mockBuildMissionContext.mockResolvedValue({ description: '## Mission', context: {} });
    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockInsertValues.mockReturnValue({ onConflictDoNothing: mockInsertOnConflictDoNothing });
    mockInsertOnConflictDoNothing.mockReturnValue({ returning: mockInsertReturning });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });

    await runMission('obj-3', undefined, deps);

    // buildMissionContext still gets decompositionSkipped=true (read from mission)
    const contextArg = mockBuildMissionContext.mock.calls[0][1] as Record<string, unknown>;
    expect(contextArg.decompositionSkipped).toBe(true);

    // db.update() must NOT be called (no new detection — already persisted)
    expect(mockUpdate).not.toHaveBeenCalled();

    // Only one insert: the planning task (no note insert since it's already persisted)
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('skips pre-filed detection for manual-mode missions', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-4',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'Manual Mission',
      priority: 0,
      orchestrationMode: 'manual',
      decompositionSkipped: false,
      schedule: null,
    });

    // dominantRole select only (detection skipped for manual mode)
    selectResults[0] = [];

    mockBuildMissionContext.mockResolvedValue({ description: '## Mission', context: {} });
    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockInsertValues.mockReturnValue({ onConflictDoNothing: mockInsertOnConflictDoNothing });
    mockInsertOnConflictDoNothing.mockReturnValue({ returning: mockInsertReturning });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });

    await runMission('obj-4', undefined, deps);

    // buildMissionContext must NOT have decompositionSkipped=true for manual mode
    const contextArg = mockBuildMissionContext.mock.calls[0][1] as Record<string, unknown>;
    expect(contextArg.decompositionSkipped).toBeFalsy();

    // db.update() must NOT be called
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('blocks spawn and returns skippedBudgetExhausted when spend >= budget', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'Expensive Mission',
      priority: 0,
      schedule: null,
      costBudgetUsd: '0.01',
    });

    mockGetMissionSpendUsd.mockResolvedValue(0.05);

    const result = await runMission('obj-1', undefined, deps);

    expect(result.task).toBeNull();
    expect(result.skippedBudgetExhausted).toBe(true);
    expect(mockExhaustMissionBudget).toHaveBeenCalledWith('obj-1', 'Expensive Mission', 0.05, 0.01);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });

  it('allows spawn when spend < budget', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'Under Budget Mission',
      priority: 0,
      schedule: null,
      costBudgetUsd: '10.00',
    });

    mockGetMissionSpendUsd.mockResolvedValue(5.00);
    mockBuildMissionContext.mockResolvedValue({ description: '## Mission', context: {} });
    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });
    selectResults[0] = [];

    const result = await runMission('obj-1', undefined, deps);

    expect(result.task).not.toBeNull();
    expect(result.skippedBudgetExhausted).toBeUndefined();
    expect(mockExhaustMissionBudget).not.toHaveBeenCalled();
  });

  it('skips budget check when costBudgetUsd is null', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-1',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      title: 'No Budget Mission',
      priority: 0,
      schedule: null,
      costBudgetUsd: null,
    });

    mockBuildMissionContext.mockResolvedValue({ description: '## Mission', context: {} });
    mockInsertReturning.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });
    selectResults[0] = [];

    const result = await runMission('obj-1', undefined, deps);

    expect(result.task).not.toBeNull();
    expect(mockGetMissionSpendUsd).not.toHaveBeenCalled();
    expect(mockExhaustMissionBudget).not.toHaveBeenCalled();
  });
});

// ── Open-PR planning gate (B7 / P3) ──────────────────────────────────────────
// `missions.primaryPrNumber` is "the first PR any task of this mission opened",
// not "the mission's PR". Gating planning on it halted the whole mission for
// whichever sibling PR happened to be first, while the mission's other open PRs
// went uncounted. The gate now keys off an open PR whose paths overlap the
// mission's known remaining scope.
describe('runMission — open-PR planning gate', () => {
  beforeEach(resetMissionRunMocks);

  const ACTIVE_MISSION = {
    id: 'obj-1',
    teamId: 'team-1',
    workspaceId: 'ws-1',
    status: 'active',
    title: 'My Mission',
    priority: 0,
    schedule: null,
    costBudgetUsd: null,
  };

  function armPlanningSuccess() {
    mockBuildMissionContext.mockResolvedValue({ description: '## Mission', context: {} });
    mockInsertReturning.mockResolvedValue([{ id: 'task-new', workspaceId: 'ws-1', mode: 'planning' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });
  }

  it('plans anyway when the open PR does not overlap the remaining scope', async () => {
    mockMissionsFindFirst.mockResolvedValue({ ...ACTIVE_MISSION, primaryPrNumber: 41, primaryPrUrl: 'https://github.com/o/r/pull/41' });
    // Pre-fix path: the guard asked GitHub for the primary PR and paused on it.
    mockGetMissionPrState.mockResolvedValue({
      prNumber: 41, prUrl: 'https://github.com/o/r/pull/41', state: 'open', merged: false,
      headSha: 'sha-41', mergeable: true, installationId: 1, repoFullName: 'o/r',
    });
    // PR #41 belongs to task-a (docs only). The mission's remaining work is
    // task-b, which touches a completely different file.
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-a', status: 'completed', pathManifest: ['docs/readme.md'] },
      { id: 'task-b', status: 'pending', pathManifest: ['apps/web/src/lib/foo.ts'] },
    ]);
    mockWorkersFindMany.mockResolvedValue([
      { taskId: 'task-a', prNumber: 41, prUrl: 'https://github.com/o/r/pull/41', lastCommitSha: 'sha-41', prLifecycleStatus: 'pr_open' },
    ]);
    armPlanningSuccess();

    const result = await runMission('obj-1', undefined, deps);

    expect(result.skippedPrOpen).toBeUndefined();
    expect(result.task).not.toBeNull();
    expect(mockNotifyMissionPrReady).not.toHaveBeenCalled();
  });

  it('pauses on a sibling open PR that overlaps the remaining scope, even when it is not the primary PR', async () => {
    // primaryPrNumber is unset — pre-fix this mission could never pause, so the
    // organizer kept fanning out work onto files an open PR already owned.
    mockMissionsFindFirst.mockResolvedValue({ ...ACTIVE_MISSION, primaryPrNumber: null, primaryPrUrl: null });
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-a', status: 'completed', pathManifest: ['apps/web/src/lib/foo.ts'] },
      { id: 'task-b', status: 'pending', pathManifest: ['apps/web/src/lib/foo.ts'] },
    ]);
    mockWorkersFindMany.mockResolvedValue([
      { taskId: 'task-a', prNumber: 77, prUrl: 'https://github.com/o/r/pull/77', lastCommitSha: 'sha-77', prLifecycleStatus: 'pr_open' },
    ]);
    armPlanningSuccess();

    const result = await runMission('obj-1', undefined, deps);

    expect(result.skippedPrOpen).toBe(true);
    expect(result.task).toBeNull();
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
    const [missionId, opts] = mockNotifyMissionPrReady.mock.calls[0] as any[];
    expect(missionId).toBe('obj-1');
    expect(opts.prNumber).toBe(77);
    expect(opts.headSha).toBe('sha-77');
    expect(opts.message).toContain('apps/web/src/lib/foo.ts');
  });

  it('plans when the mission has no open PRs at all', async () => {
    mockMissionsFindFirst.mockResolvedValue({ ...ACTIVE_MISSION, primaryPrNumber: 41, primaryPrUrl: 'https://github.com/o/r/pull/41' });
    mockGetMissionPrState.mockResolvedValue({
      prNumber: 41, prUrl: 'https://github.com/o/r/pull/41', state: 'open', merged: false,
      headSha: 'sha-41', mergeable: true, installationId: 1, repoFullName: 'o/r',
    });
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-a', status: 'completed', pathManifest: ['apps/web/src/lib/foo.ts'] },
      { id: 'task-b', status: 'pending', pathManifest: ['apps/web/src/lib/foo.ts'] },
    ]);
    // PR #41 already merged — worker row carries mergedAt, so it is not open.
    mockWorkersFindMany.mockResolvedValue([]);
    armPlanningSuccess();

    const result = await runMission('obj-1', undefined, deps);

    expect(result.skippedPrOpen).toBeUndefined();
    expect(result.task).not.toBeNull();
  });

  it('plans (does not pause) when the remaining scope is undeclared — the overlap is unknowable', async () => {
    mockMissionsFindFirst.mockResolvedValue({ ...ACTIVE_MISSION, primaryPrNumber: 41, primaryPrUrl: 'https://github.com/o/r/pull/41' });
    mockGetMissionPrState.mockResolvedValue({
      prNumber: 41, prUrl: 'https://github.com/o/r/pull/41', state: 'open', merged: false,
      headSha: 'sha-41', mergeable: true, installationId: 1, repoFullName: 'o/r',
    });
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-a', status: 'completed', pathManifest: ['apps/web/src/lib/foo.ts'] },
      // Remaining work declares no scope: '**' and null are equally undeclared.
      { id: 'task-b', status: 'pending', pathManifest: ['**'] },
      { id: 'task-c', status: 'pending', pathManifest: null },
    ]);
    mockWorkersFindMany.mockResolvedValue([
      { taskId: 'task-a', prNumber: 41, prUrl: 'https://github.com/o/r/pull/41', lastCommitSha: 'sha-41', prLifecycleStatus: 'pr_open' },
    ]);
    armPlanningSuccess();

    const result = await runMission('obj-1', undefined, deps);

    expect(result.skippedPrOpen).toBeUndefined();
    expect(result.task).not.toBeNull();
    expect(mockNotifyMissionPrReady).not.toHaveBeenCalled();
  });

  it('ignores an open PR whose own scope is undeclared (advisory only)', async () => {
    mockMissionsFindFirst.mockResolvedValue({ ...ACTIVE_MISSION, primaryPrNumber: null, primaryPrUrl: null });
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-a', status: 'completed', pathManifest: ['**'] },
      { id: 'task-b', status: 'pending', pathManifest: ['apps/web/src/lib/foo.ts'] },
    ]);
    mockWorkersFindMany.mockResolvedValue([
      { taskId: 'task-a', prNumber: 77, prUrl: 'https://github.com/o/r/pull/77', lastCommitSha: 'sha-77', prLifecycleStatus: 'pr_open' },
    ]);
    armPlanningSuccess();

    const result = await runMission('obj-1', undefined, deps);

    expect(result.skippedPrOpen).toBeUndefined();
    expect(result.task).not.toBeNull();
  });

  it('ignores a closed PR', async () => {
    mockMissionsFindFirst.mockResolvedValue({ ...ACTIVE_MISSION, primaryPrNumber: null, primaryPrUrl: null });
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-a', status: 'completed', pathManifest: ['apps/web/src/lib/foo.ts'] },
      { id: 'task-b', status: 'pending', pathManifest: ['apps/web/src/lib/foo.ts'] },
    ]);
    mockWorkersFindMany.mockResolvedValue([
      { taskId: 'task-a', prNumber: 77, prUrl: 'https://github.com/o/r/pull/77', lastCommitSha: 'sha-77', prLifecycleStatus: 'closed' },
    ]);
    armPlanningSuccess();

    const result = await runMission('obj-1', undefined, deps);

    expect(result.skippedPrOpen).toBeUndefined();
    expect(result.task).not.toBeNull();
  });
});

/**
 * The integration-branch blocker note must not outlive the failure it describes.
 *
 * The note is deduped on `(missionId, title, status='open')` so a durable failure
 * is reported once instead of once per organizer cycle. That is right, but it has
 * a second effect nobody asked for: while the note stays open it also SUPPRESSES
 * the next report. Nothing ever resolved it, so after one transient failure the
 * mission carried a permanently-open note that both said something untrue and
 * swallowed the next genuine failure — the one an operator needed to see.
 */
describe('runMission — integration branch note lifecycle', () => {
  beforeEach(resetMissionRunMocks);

  const NOTE_TITLE = 'Integration branch unavailable';
  const BRANCH = 'mission/my-mission-obj-1';
  const OPTED_IN_MISSION = {
    id: 'obj-1',
    teamId: 'team-1',
    workspaceId: 'ws-1',
    status: 'active',
    title: 'My Mission',
    priority: 0,
    schedule: null,
    costBudgetUsd: null,
    workingBranch: BRANCH,
    integrationBranchEnabled: true,
  };

  function armPlanning() {
    mockBuildMissionContext.mockResolvedValue({ description: '## Mission', context: {} });
    mockInsertReturning.mockResolvedValue([{ id: 'task-new', workspaceId: 'ws-1', mode: 'planning' }]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS', repo: 'example-org/example-repo' });
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockReturnValue({ onConflictDoNothing: mockInsertOnConflictDoNothing });
    mockInsertOnConflictDoNothing.mockReturnValue({ returning: mockInsertReturning });
  }

  /** Leaves of the mocked drizzle predicate tree. */
  function leaves(cond: any): any[] {
    if (!cond || typeof cond !== 'object') return [];
    if (Array.isArray(cond.args)) return cond.args.flatMap(leaves);
    if (Array.isArray(cond.conditions)) return cond.conditions.flatMap(leaves);
    return [cond];
  }

  const noteInserts = () =>
    mockInsertValues.mock.calls
      .map(c => c[0] as any)
      .filter(v => v?.title === NOTE_TITLE);

  const noteUpdates = () =>
    recordedUpdates.filter(u =>
      leaves(u.where).some(l => l.field === 'title' && l.value === NOTE_TITLE)
      || leaves(u.where).some(l => l.field === 'id' && l.value === 'note-stale'),
    );

  it('resolves the open blocker note once the branch exists', async () => {
    // Otherwise the note is immortal: it stays open, keeps claiming the branch is
    // missing, and its own dedupe key then eats the next real failure.
    mockMissionsFindFirst.mockResolvedValue({ ...OPTED_IN_MISSION });
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: BRANCH, created: true } as any);
    updateReturningRows = [{ id: 'note-stale' }];
    armPlanning();

    await runMission('obj-1', undefined, deps);

    const resolutions = noteUpdates();
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].set.status).toBe('superseded');
    // Scoped: this mission, this note title, and only rows still open.
    const where = leaves(resolutions[0].where);
    expect(where).toContainEqual({ field: 'missionId', value: 'obj-1', type: 'eq' });
    expect(where).toContainEqual({ field: 'title', value: NOTE_TITLE, type: 'eq' });
    expect(where).toContainEqual({ field: 'status', value: 'open', type: 'eq' });
    // And nothing new is posted on a success.
    expect(noteInserts()).toHaveLength(0);
  });

  it('posts the blocker note when the branch is unavailable and none is open', async () => {
    mockMissionsFindFirst.mockResolvedValue({ ...OPTED_IN_MISSION });
    mockEnsureMissionIntegrationBranch.mockResolvedValue({
      ok: false, reason: 'api_error', detail: 'Object does not exist',
    } as any);
    mockMissionNotesFindFirst.mockResolvedValue(null);
    armPlanning();

    await runMission('obj-1', undefined, deps);

    const posted = noteInserts();
    expect(posted).toHaveLength(1);
    expect(posted[0].status).toBe('open');
    expect(posted[0].body).toContain('api_error');
    expect(posted[0].body).toContain(BRANCH);
  });

  it('refreshes the open note instead of adding a second row when it fails again', async () => {
    // One open blocker note per mission — but it must describe the CURRENT
    // failure. A second, different reason arriving while the note is open was
    // dropped entirely, which is the same swallow in a shorter window.
    mockMissionsFindFirst.mockResolvedValue({ ...OPTED_IN_MISSION });
    mockEnsureMissionIntegrationBranch.mockResolvedValue({
      ok: false, reason: 'empty_repo', detail: 'Git Repository is empty.',
    } as any);
    mockMissionNotesFindFirst.mockResolvedValue({ id: 'note-stale' });
    armPlanning();

    await runMission('obj-1', undefined, deps);

    expect(noteInserts()).toHaveLength(0);
    const refreshed = noteUpdates();
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].set.body).toContain('empty_repo');
    expect(refreshed[0].set.status).toBeUndefined(); // still open — still broken
  });

  it('leaves notes alone for a mission that has not opted in', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      ...OPTED_IN_MISSION,
      integrationBranchEnabled: false,
    });
    armPlanning();

    await runMission('obj-1', undefined, deps);

    expect(mockEnsureMissionIntegrationBranch).not.toHaveBeenCalled();
    expect(noteUpdates()).toHaveLength(0);
    expect(noteInserts()).toHaveLength(0);
  });
});
