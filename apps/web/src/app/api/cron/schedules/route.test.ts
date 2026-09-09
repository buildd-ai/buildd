import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// --- Mock setup ---

// Set CRON_SECRET before importing the route
process.env.CRON_SECRET = 'test-secret';

const mockTaskSchedulesFindMany = mock(() => [] as any[]);
const mockMissionsFindFirst = mock(() => null as any);
const mockMissionsFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => ({ id: 'ws-1', name: 'Test Workspace' }) as any);
const mockWorkerHeartbeatsFindMany = mock(() => [] as any[]);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockAccountsFindMany = mock(() => [] as any[]);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockReportOps = mock(() => Promise.resolve());
const mockNotify = mock(() => {});
const mockIsOverdue = mock(() => false);
const mockEstimateCronIntervalMs = mock(() => 30 * 60 * 1000);

let taskSchedulesUpdateCalls: any[] = [];
let tasksInsertValues: any = null;
let mockSelectCount = 0;
// When set, the task insert throws it — lets tests drive the per-schedule
// failure catch block (transient DB error path).
let insertError: Error | null = null;
let insertConflict = false;

const makeUpdateChain = (calls: any[]) => ({
  set: mock((vals: any) => {
    const entry: any = { set: vals };
    calls.push(entry);
    return {
      where: mock((cond: any) => {
        entry.where = cond;
        return {
          returning: mock(() => [{ id: 'sched-1', ...vals }]),
        };
      }),
    };
  }),
});

/**
 * The cron_runs table stub, shared between the schema mock and the db mock so
 * inserts can be attributed. withCronRun writes a run row through the same
 * `db.insert`, and an untargeted capture counts it as the route's own write.
 */
const CRON_RUNS_TABLE = { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' };

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      taskSchedules: { findMany: mockTaskSchedulesFindMany },
      missions: { findFirst: mockMissionsFindFirst, findMany: mockMissionsFindMany },
      tasks: { findFirst: mockTasksFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      workers: { findMany: mockWorkersFindMany },
      workerHeartbeats: { findMany: mockWorkerHeartbeatsFindMany },
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
      accounts: { findMany: mockAccountsFindMany },
    },
    insert: mock((table: any) => ({
      values: mock((vals: any) => {
        if (table === CRON_RUNS_TABLE) return { returning: mock(() => [{ id: 'run-1' }]) };
        tasksInsertValues = vals;
        if (insertError) throw insertError;
        // `insertConflict` models the partial unique index
        // tasks_active_planning_per_mission swallowing the row: with
        // onConflictDoNothing the insert succeeds and returns nothing.
        const rows = insertConflict ? [] : [{ id: 'task-1', ...vals }];
        return {
          returning: mock(() => rows),
          onConflictDoNothing: mock(() => ({
            returning: mock(() => rows),
          })),
        };
      }),
    })),
    update: mock((_table: any) => makeUpdateChain(taskSchedulesUpdateCalls)),
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => [{ count: mockSelectCount }]),
      })),
    })),
    delete: mock((_table: any) => ({
      where: mock(() => Promise.resolve()),
    })),
  },
}));

mock.module('drizzle-orm', () => ({
  // Operators withCronRun imports. mock.module is process-global, so a
  // partial stub removes them for every other importer too.
  desc: (a: any) => ({ a, op: 'desc' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => args,
  lte: (field: any, value: any) => ({ field, value, type: 'lte' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ raw: strings.join(''), values }),
    { raw: (s: string) => s }
  ),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  // withCronRun imports this; mock.module replaces the whole module, so a
  // partial stub deletes the export for every other importer in the process.
  cronRuns: CRON_RUNS_TABLE,
  taskSchedules: 'taskSchedules',
  tasks: 'tasks',
  workspaces: 'workspaces',
  missions: 'missions',
  workers: 'workers',
  workerHeartbeats: 'workerHeartbeats',
  accounts: 'accounts',
  accountWorkspaces: 'accountWorkspaces',
}));

mock.module('@/lib/schedule-helpers', () => ({
  computeNextRunAt: () => new Date('2026-01-01'),
  classifyScheduleCadence: () => ({ kind: 'standard', complexity: 'medium', classifiedBy: 'default' }),
}));

mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mock(() => Promise.resolve()),
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { SCHEDULE_TRIGGERED: 'schedule-triggered', SCHEDULE_DEFERRED: 'schedule:deferred' },
}));

mock.module('@/lib/mission-context', () => ({
  buildMissionContext: mock(() => Promise.resolve(null)),
  isWithinActiveHours: mock(() => true),
}));

const mockGetOrCreateCoordinationWorkspace = mock(() => Promise.resolve({ id: 'orchestrator-ws' }));
mock.module('@/lib/orchestrator-workspace', () => ({
  getOrCreateCoordinationWorkspace: mockGetOrCreateCoordinationWorkspace,
}));

mock.module('@buildd/core/report-ops', () => ({
  reportOps: mockReportOps,
}));

mock.module('@/lib/heartbeat-helpers', () => ({
  isOverdue: mockIsOverdue,
  estimateCronIntervalMs: mockEstimateCronIntervalMs,
}));

mock.module('@/lib/pushover', () => ({
  notify: mockNotify,
}));

// Heartbeat decision chain. Inert for non-heartbeat schedules (the prepass is
// only consulted when taskTemplate.context.heartbeat === true), so these mocks
// do not disturb the rest of the file.
const mockPrepass = mock(() => Promise.resolve({ action: 'invoke_llm', stateKey: 'sk-1' } as any));
mock.module('@/lib/heartbeat-prepass', () => ({
  evaluateHeartbeatPrepass: mockPrepass,
}));

const mockCompleteMission = mock(() => Promise.resolve({ completed: true, decision: { code: 'ok' } } as any));
mock.module('@/lib/mission-completion', () => ({
  completeMissionIfVerified: mockCompleteMission,
  isCriteriaBlockCode: (code: string) => ['criteria_failed', 'criteria_pending', 'criteria_unverified'].includes(code),
}));

const mockApplyCriteriaRearm = mock(() => Promise.resolve({
  action: 'wait', reason: 'stub', nextCycles: 0, verdictLines: '', fingerprint: 'fp',
} as any));
mock.module('@/lib/criteria-rearm', () => ({
  applyCriteriaRearm: mockApplyCriteriaRearm,
}));

import { GET } from './route';

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/cron/schedules', {
    method: 'GET',
    headers: {
      authorization: 'Bearer test-secret',
      ...headers,
    },
  });
}

function makeSchedule(overrides: Partial<any> = {}): any {
  return {
    id: 'sched-1',
    workspaceId: 'ws-1',
    name: 'Test Schedule',
    cronExpression: '0 * * * *',
    timezone: 'UTC',
    taskTemplate: { title: 'Test Task', mode: 'execution', priority: 0 },
    enabled: true,
    oneShot: false,
    nextRunAt: new Date('2025-01-01'),
    lastRunAt: null,
    lastTaskId: null,
    totalRuns: 0,
    consecutiveFailures: 0,
    lastError: null,
    maxConcurrentFromSchedule: 0,
    pauseAfterFailures: 5,
    lastTriggerValue: null,
    totalChecks: 0,
    ...overrides,
  };
}

describe('GET /api/cron/schedules', () => {
  beforeEach(() => {
    mockTaskSchedulesFindMany.mockReset();
    mockMissionsFindFirst.mockReset();
    mockMissionsFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkerHeartbeatsFindMany.mockReset();
    mockAccountWorkspacesFindMany.mockReset();
    mockAccountsFindMany.mockReset();
    mockWorkersFindMany.mockReset();
    mockReportOps.mockReset();
    mockNotify.mockReset();
    mockIsOverdue.mockReset();
    mockIsOverdue.mockReturnValue(false);
    mockEstimateCronIntervalMs.mockReset();
    mockEstimateCronIntervalMs.mockReturnValue(30 * 60 * 1000);
    mockGetOrCreateCoordinationWorkspace.mockReset();
    mockGetOrCreateCoordinationWorkspace.mockResolvedValue({ id: 'orchestrator-ws' });
    mockPrepass.mockReset();
    mockPrepass.mockResolvedValue({ action: 'invoke_llm', stateKey: 'sk-1' } as any);
    mockCompleteMission.mockReset();
    mockCompleteMission.mockResolvedValue({ completed: true, decision: { code: 'ok' } } as any);
    mockApplyCriteriaRearm.mockReset();
    mockApplyCriteriaRearm.mockResolvedValue({
      action: 'wait', reason: 'stub', nextCycles: 0, verdictLines: '', fingerprint: 'fp',
    } as any);
    taskSchedulesUpdateCalls = [];
    tasksInsertValues = null;
    mockSelectCount = 0;
    insertError = null;
    insertConflict = false;

    mockTaskSchedulesFindMany.mockResolvedValue([]);
    mockMissionsFindFirst.mockResolvedValue(null);
    mockMissionsFindMany.mockResolvedValue([]);
    mockTasksFindFirst.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'Test Workspace' });
    mockWorkerHeartbeatsFindMany.mockResolvedValue([]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);
    mockAccountsFindMany.mockResolvedValue([]);
    mockWorkersFindMany.mockResolvedValue([]);
  });

  it('alerts via reportOps when a runner heartbeat goes stale even with no active workers', async () => {
    // Idle-but-wedged runner: heartbeat is stale but it has no running workers,
    // so the orphan-failover finds nothing. We must still alert.
    mockWorkerHeartbeatsFindMany.mockResolvedValue([{ id: 'hb-1', accountId: 'acct-1' }]);
    mockWorkersFindMany.mockResolvedValue([]); // no orphaned workers

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const call = mockReportOps.mock.calls.find((c: any[]) => c[0]?.source === 'runner-offline');
    expect(call).toBeTruthy();
    expect(call[0].severity).toBe('error');
  });

  it('should resolve workspace from mission when schedule.workspaceId is null', async () => {
    const schedule = makeSchedule({ workspaceId: null });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', workspaceId: 'ws-from-mission', status: 'active' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-from-mission', name: 'Mission Workspace' });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.errors).toBe(0);

    // Task should be created with workspace from mission
    expect(tasksInsertValues).not.toBeNull();
    expect(tasksInsertValues.workspaceId).toBe('ws-from-mission');
  });

  it('should auto-create orchestrator workspace when mission has teamId but no workspace', async () => {
    const schedule = makeSchedule({ workspaceId: null });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', workspaceId: null, teamId: 'team-1', status: 'active' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'orchestrator-ws', name: '__coordination' });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.errors).toBe(0);

    // Verify orchestrator workspace was used
    expect(mockGetOrCreateCoordinationWorkspace).toHaveBeenCalledWith('team-1');
    expect(tasksInsertValues).not.toBeNull();
    expect(tasksInsertValues.workspaceId).toBe('orchestrator-ws');
  });

  it('should fail gracefully when no mission and schedule lacks workspace', async () => {
    const schedule = makeSchedule({ workspaceId: null });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue(null);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.errors).toBe(1);

    // Should have incremented failures and recorded error
    const updateCall = taskSchedulesUpdateCalls.find(c =>
      c.set?.lastError?.includes('No workspace')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall.set.consecutiveFailures).toBe(1);
  });

  // --- Alert-noise suppression on transient DB failures ---

  // Reproduces how the neon-http Drizzle driver throws: a useless outer
  // "Failed query: <SQL>" message with the real NeonDbError on .cause.
  function makeNeonError(): Error {
    const cause = Object.assign(
      new Error('insert or update on table "tasks" violates foreign key constraint'),
      { code: '23503', constraint: 'tasks_workspace_id_workspaces_id_fk', detail: 'Key (workspace_id)=(x) is not present in table "workspaces".' },
    );
    const outer = new Error('Failed query: insert into "tasks" (...) values ($1, $2, ...) returning "id"');
    (outer as { cause?: unknown }).cause = cause;
    return outer;
  }

  /**
   * A mission schedule on a half-hourly cron fires while its previous planning
   * task is still active. The unique index tasks_active_planning_per_mission exists
   * precisely to stop a second concurrent planning cycle — so losing that race
   * is the guard working, not a fault.
   *
   * mission-run.ts already treats it that way (onConflictDoNothing + a graceful
   * `deduped` return). This cron path did a bare insert, so the 23505 escaped to
   * the per-schedule catch and was booked as a failure: it incremented
   * consecutiveFailures and wrote a raw Postgres string to lastError, which
   * marches an otherwise-healthy schedule toward its pauseAfterFailures
   * threshold on nothing but successful contention.
   */
  it('books a lost planning-dedupe race as skipped, not as a failure', async () => {
    const schedule = makeSchedule({
      workspaceId: 'ws-1',
      consecutiveFailures: 0,
      taskTemplate: { title: 'Mission: Something', mode: 'planning', priority: 0 },
    });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    insertConflict = true;

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.errors).toBe(0);
    expect(body.created).toBe(0);
    expect(body.skipped).toBe(1);

    // consecutiveFailures must not advance — otherwise repeated healthy
    // contention eventually trips pauseAfterFailures and disables the schedule.
    const failureUpdate = taskSchedulesUpdateCalls.find(c => c.set?.consecutiveFailures === 1);
    expect(failureUpdate).toBeUndefined();
  });

  it('does not crash dispatching a conflicted insert (no task row to dispatch)', async () => {
    // Regression guard: the code after the insert dereferences task.id for
    // lastTaskId, dispatch, and the Pusher payload. onConflictDoNothing makes
    // that row absent, so an unguarded path would throw on undefined.
    const schedule = makeSchedule({
      workspaceId: 'ws-1',
      taskTemplate: { title: 'Mission: Something', mode: 'planning', priority: 0 },
    });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    insertConflict = true;

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toBe(0);
    // The conflicted branch returns before the post-insert bookkeeping, so there
    // must be no lastTaskId write at all — and above all none carrying an
    // undefined id, which is what an unguarded `task.id` would have produced.
    const badLastTaskId = taskSchedulesUpdateCalls.find(
      c => 'lastTaskId' in (c.set ?? {}) && c.set.lastTaskId === undefined,
    );
    expect(badLastTaskId).toBeUndefined();
  });

  it('does NOT page on a single transient failure, but records the diagnosable cause', async () => {
    const schedule = makeSchedule({ workspaceId: 'ws-1', consecutiveFailures: 0 });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    insertError = makeNeonError();

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.errors).toBe(1);

    // No ops page for a lone failure — it self-recovers next tick.
    const opsCall = mockReportOps.mock.calls.find((c: any[]) => c[0]?.source === 'cron-schedules');
    expect(opsCall).toBeUndefined();

    // lastError must carry the neon cause (SQLSTATE/constraint), not the giant SQL dump.
    const updateCall = taskSchedulesUpdateCalls.find(c => c.set?.consecutiveFailures === 1);
    expect(updateCall).toBeDefined();
    expect(updateCall.set.lastError).toContain('(23503)');
    expect(updateCall.set.lastError).toContain('violates foreign key constraint');
    expect(updateCall.set.lastError).not.toContain('Failed query');
  });

  it('escalates to an error page once failures are sustained (>= threshold)', async () => {
    // Already failed twice; this tick makes it 3 consecutive → page.
    const schedule = makeSchedule({ workspaceId: 'ws-1', consecutiveFailures: 2 });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    insertError = makeNeonError();

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const opsCall = mockReportOps.mock.calls.find((c: any[]) => c[0]?.source === 'cron-schedules');
    expect(opsCall).toBeTruthy();
    expect(opsCall[0].severity).toBe('error');
    expect(opsCall[0].detail).toContain('3 consecutive failures');
    expect(opsCall[0].detail).toContain('(23503)');
  });

  it('pages (and pauses) when the schedule hits its pauseAfterFailures cap even below the threshold', async () => {
    // pauseAfterFailures=2, one prior failure → this tick is failure #2:
    // below ALERT_ESCALATION_THRESHOLD (3) but it triggers a pause, which is
    // worth paging on.
    const schedule = makeSchedule({ workspaceId: 'ws-1', consecutiveFailures: 1, pauseAfterFailures: 2 });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    insertError = makeNeonError();

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const opsCall = mockReportOps.mock.calls.find((c: any[]) => c[0]?.source === 'cron-schedules');
    expect(opsCall).toBeTruthy();
    expect(opsCall[0].severity).toBe('error');

    const updateCall = taskSchedulesUpdateCalls.find(c => c.set?.consecutiveFailures === 2);
    expect(updateCall).toBeDefined();
    expect(updateCall.set.enabled).toBe(false);
  });

  it('should pass triggerSource cron to buildMissionContext for mission-linked schedules', async () => {
    const { buildMissionContext } = await import('@/lib/mission-context');
    const mockBuildCtx = buildMissionContext as ReturnType<typeof mock>;
    mockBuildCtx.mockResolvedValue({
      description: 'Test mission context',
      context: { missionId: 'mission-1', orchestrator: true },
    });

    const schedule = makeSchedule({
      workspaceId: null,
      taskTemplate: {
        title: 'Mission: Test',
        mode: 'planning',
        priority: 0,
        context: { heartbeat: true, heartbeatChecklist: '- check stuff' },
      },
    });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', workspaceId: 'ws-1', status: 'active' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'Test Workspace' });

    await GET(makeRequest());

    // buildMissionContext should receive triggerSource: 'cron' so heartbeat mode activates
    expect(mockBuildCtx).toHaveBeenCalledWith('mission-1', expect.objectContaining({
      triggerSource: 'cron',
      heartbeat: true,
    }));
  });

  describe('criteria-blocked heartbeat', () => {
    function heartbeatSchedule() {
      return makeSchedule({
        workspaceId: 'ws-1',
        taskTemplate: {
          title: 'Mission: Blocked',
          mode: 'planning',
          priority: 0,
          context: { heartbeat: true },
        },
      });
    }

    function arrangeBlockedMission(rearm: Record<string, unknown>) {
      mockTaskSchedulesFindMany.mockResolvedValue([heartbeatSchedule()]);
      mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', workspaceId: 'ws-1', status: 'active' });
      // Every deliverable terminal → the prepass proposes completion...
      mockPrepass.mockResolvedValue({ action: 'skip_complete' } as any);
      // ...and the criteria gate refuses it.
      mockCompleteMission.mockResolvedValue({
        completed: false,
        decision: {
          code: 'criteria_failed',
          reason: 'Goal criteria failed — [fail] Design doc exists: no artifact found',
          criteriaVerdict: { kind: 'value', value: 'fail' },
        },
      } as any);
      mockApplyCriteriaRearm.mockResolvedValue(rearm as any);
    }

    it('dispatches an organizer cycle carrying the verdict instead of skipping', async () => {
      // The deadlock this fixes: the verdict blocked completion, the heartbeat
      // deferred, and no organizer cycle was ever created — so the mission could
      // neither close nor file the work that would let it close.
      const { buildMissionContext } = await import('@/lib/mission-context');
      const mockBuildCtx = buildMissionContext as ReturnType<typeof mock>;
      mockBuildCtx.mockResolvedValue({ description: 'ctx', context: { missionId: 'mission-1' } });

      arrangeBlockedMission({
        action: 'rearm',
        reason: 'Goal-criteria verdict changed since the last organizer cycle',
        nextCycles: 1,
        verdictLines: '- [fail] Design doc exists — no artifact found',
        fingerprint: 'fp-A',
      });

      const res = await GET(makeRequest());
      const body = await res.json();

      expect(body.criteriaRearmInvocations).toBe(1);
      expect(tasksInsertValues).not.toBeNull();
      expect(tasksInsertValues.missionId).toBe('mission-1');
      expect(mockBuildCtx).toHaveBeenCalledWith('mission-1', expect.objectContaining({
        criteriaRearm: expect.objectContaining({
          overall: 'fail',
          verdictLines: '- [fail] Design doc exists — no artifact found',
        }),
      }));
    });

    it('does not write the no-change state hash on a re-arm cycle', async () => {
      // Writing it would make the next tick read "state unchanged" and suppress
      // the very cycle the re-arm just authorised.
      arrangeBlockedMission({
        action: 'rearm', reason: 'r', nextCycles: 1, verdictLines: '', fingerprint: 'fp-A',
      });

      await GET(makeRequest());

      const hashWrite = taskSchedulesUpdateCalls.find(c => 'lastHeartbeatStateHash' in (c.set ?? {}));
      expect(hashWrite).toBeUndefined();
    });

    it('defers without a cycle when the re-arm guard says wait', async () => {
      arrangeBlockedMission({
        action: 'wait', reason: 'work in flight', nextCycles: 2, verdictLines: '', fingerprint: 'fp-A',
      });

      const res = await GET(makeRequest());
      const body = await res.json();

      expect(body.criteriaRearmInvocations).toBe(0);
      expect(tasksInsertValues).toBeNull();
      const deferral = taskSchedulesUpdateCalls.find(c => c.set?.lastDeferralReason === 'heartbeat_criteria_blocked');
      expect(deferral).toBeDefined();
    });

    it('does not re-arm when completion was refused for a non-criteria reason', async () => {
      arrangeBlockedMission({ action: 'rearm', reason: 'r', nextCycles: 1, verdictLines: '', fingerprint: 'fp' });
      mockCompleteMission.mockResolvedValue({
        completed: false,
        decision: { code: 'infra_stalled', reason: 'a deliverable died on infra', criteriaVerdict: { kind: 'value', value: 'pass' } },
      } as any);

      const res = await GET(makeRequest());
      const body = await res.json();

      expect(mockApplyCriteriaRearm).not.toHaveBeenCalled();
      expect(body.criteriaRearmInvocations).toBe(0);
      expect(tasksInsertValues).toBeNull();
    });

    it('still skips silently when the mission completes', async () => {
      mockTaskSchedulesFindMany.mockResolvedValue([heartbeatSchedule()]);
      mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', workspaceId: 'ws-1', status: 'active' });
      mockPrepass.mockResolvedValue({ action: 'skip_complete' } as any);
      mockCompleteMission.mockResolvedValue({ completed: true, decision: { code: 'ok' } } as any);

      const res = await GET(makeRequest());
      const body = await res.json();

      expect(mockApplyCriteriaRearm).not.toHaveBeenCalled();
      expect(body.criteriaRearmInvocations).toBe(0);
      expect(tasksInsertValues).toBeNull();
    });
  });

  it('should skip task creation when mission maxConcurrentTasks cap is reached', async () => {
    mockSelectCount = 3;
    const schedule = makeSchedule({ workspaceId: 'ws-1' });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue({
      id: 'mission-1',
      workspaceId: 'ws-1',
      status: 'active',
      maxConcurrentTasks: 3,
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(body.created).toBe(0);
    expect(tasksInsertValues).toBeNull();
  });

  it('should create task when mission maxConcurrentTasks cap is not reached', async () => {
    mockSelectCount = 1;
    const schedule = makeSchedule({ workspaceId: 'ws-1' });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue({
      id: 'mission-1',
      workspaceId: 'ws-1',
      status: 'active',
      maxConcurrentTasks: 3,
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(tasksInsertValues).not.toBeNull();
  });

  it('should not enforce cap when maxConcurrentTasks is null', async () => {
    const schedule = makeSchedule({ workspaceId: 'ws-1' });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue({
      id: 'mission-1',
      workspaceId: 'ws-1',
      status: 'active',
      maxConcurrentTasks: null,
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(tasksInsertValues).not.toBeNull();
  });

  // --- Seat-aware priority scheduling ---

  it('should process high-priority mission before low-priority within same account', async () => {
    const schedHigh = makeSchedule({
      id: 'sched-high',
      workspaceId: 'ws-1',
      name: 'High Priority',
      taskTemplate: { title: 'High Priority Task', mode: 'execution', priority: 0 },
    });
    const schedLow = makeSchedule({
      id: 'sched-low',
      workspaceId: 'ws-1',
      name: 'Low Priority',
      taskTemplate: { title: 'Low Priority Task', mode: 'execution', priority: 0 },
    });

    // Return low first to verify sorting works
    mockTaskSchedulesFindMany.mockResolvedValue([schedLow, schedHigh]);

    // Batch missions: high priority for sched-high, low for sched-low
    mockMissionsFindMany.mockResolvedValue([
      { id: 'mission-high', scheduleId: 'sched-high', priority: 10 },
      { id: 'mission-low', scheduleId: 'sched-low', priority: 1 },
    ]);

    // Workspace → account mapping
    mockAccountWorkspacesFindMany.mockResolvedValue([
      { accountId: 'acct-1', workspaceId: 'ws-1' },
    ]);

    // Account with only 1 seat
    mockAccountsFindMany.mockResolvedValue([
      { id: 'acct-1', authType: 'api', maxConcurrentSessions: null, maxConcurrentWorkers: 1 },
    ]);

    // No active workers
    mockWorkersFindMany.mockResolvedValue([]);
    mockMissionsFindFirst.mockResolvedValue(null);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.created).toBe(1);
    expect(body.deferred).toBe(1);
    // The created task should be the high-priority one
    expect(tasksInsertValues).not.toBeNull();
    expect(tasksInsertValues.title).toBe('High Priority Task');
  });

  it('should emit schedule_deferred event with seats_full reason', async () => {
    const schedule = makeSchedule({ workspaceId: 'ws-1' });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindMany.mockResolvedValue([]);

    mockAccountWorkspacesFindMany.mockResolvedValue([
      { accountId: 'acct-1', workspaceId: 'ws-1' },
    ]);
    mockAccountsFindMany.mockResolvedValue([
      { id: 'acct-1', authType: 'api', maxConcurrentSessions: null, maxConcurrentWorkers: 1 },
    ]);

    // 1 active worker = already at capacity
    mockWorkersFindMany.mockResolvedValue([
      { id: 'worker-1', accountId: 'acct-1' },
    ]);
    mockMissionsFindFirst.mockResolvedValue(null);

    const { triggerEvent } = await import('@/lib/pusher');

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.created).toBe(0);
    expect(body.deferred).toBe(1);

    expect(triggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'schedule:deferred',
      {
        schedule: { id: 'sched-1', name: 'Test Schedule' },
        reason: 'seats_full',
      }
    );
  });

  it('should create all tasks when seats are plentiful', async () => {
    const sched1 = makeSchedule({ id: 'sched-1', workspaceId: 'ws-1', name: 'Schedule 1' });
    const sched2 = makeSchedule({ id: 'sched-2', workspaceId: 'ws-1', name: 'Schedule 2' });
    mockTaskSchedulesFindMany.mockResolvedValue([sched1, sched2]);
    mockMissionsFindMany.mockResolvedValue([]);

    mockAccountWorkspacesFindMany.mockResolvedValue([
      { accountId: 'acct-1', workspaceId: 'ws-1' },
    ]);
    mockAccountsFindMany.mockResolvedValue([
      { id: 'acct-1', authType: 'api', maxConcurrentSessions: null, maxConcurrentWorkers: 10 },
    ]);
    mockWorkersFindMany.mockResolvedValue([]);
    mockMissionsFindFirst.mockResolvedValue(null);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.created).toBe(2);
    expect(body.deferred).toBe(0);
  });

  it('should promote outputSchema from mission context to top-level task column', async () => {
    const heartbeatSchema = {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'action_taken', 'error'] },
        summary: { type: 'string' },
      },
      required: ['status'],
    };

    const { buildMissionContext } = await import('@/lib/mission-context');
    const mockBuildCtx = buildMissionContext as ReturnType<typeof mock>;
    mockBuildCtx.mockResolvedValue({
      description: 'Heartbeat check context',
      context: {
        missionId: 'mission-1',
        heartbeat: true,
        outputSchema: heartbeatSchema,
      },
    });

    const schedule = makeSchedule({
      workspaceId: 'ws-1',
      taskTemplate: {
        title: 'Heartbeat: Finance check',
        mode: 'execution',
        priority: 0,
        context: { heartbeat: true },
      },
    });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', workspaceId: 'ws-1', status: 'active' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'Test Workspace' });

    await GET(makeRequest());

    // outputSchema must be set as a top-level column on the task insert,
    // not just buried inside context — the runner reads task.outputSchema
    expect(tasksInsertValues).not.toBeNull();
    expect(tasksInsertValues.outputSchema).toEqual(heartbeatSchema);
  });

  // Regression: a mission-linked (orchestrator) cron cycle whose stored
  // taskTemplate has lost its `mode` key must still default to 'planning', not
  // 'execution'. Falling back to 'execution' meant resolveOutputFormat() never
  // requested structured output, so the organizer's "plan" was free-form prose
  // discarded on completion — the mission looked alive and created nothing.
  it('defaults an orchestrator (mission-linked) cycle to mode=planning when the template omits mode', async () => {
    const schedule = makeSchedule({
      workspaceId: 'ws-1',
      taskTemplate: {
        title: 'Mission: No Mode',
        priority: 0,
        context: { heartbeat: true },
      },
    });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', workspaceId: 'ws-1', status: 'active' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'Test Workspace' });

    await GET(makeRequest());

    expect(tasksInsertValues).not.toBeNull();
    expect(tasksInsertValues.mode).toBe('planning');
    expect(tasksInsertValues.taskClass).toBe('bookkeeping');
    expect(tasksInsertValues.creationSource).toBe('orchestrator');
  });

  // A bare (non-mission) schedule with no explicit mode still defaults to
  // 'execution' — it has no plan to materialize, only work to do. The
  // planning-default above must not widen to every schedule.
  it('keeps the execution default for a non-mission schedule when the template omits mode', async () => {
    const schedule = makeSchedule({
      workspaceId: 'ws-1',
      taskTemplate: {
        title: 'Bare schedule',
        priority: 0,
      },
    });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'Test Workspace' });

    await GET(makeRequest());

    expect(tasksInsertValues).not.toBeNull();
    expect(tasksInsertValues.mode).toBe('execution');
    expect(tasksInsertValues.creationSource).toBe('schedule');
  });

  it('should record lastDeferralReason=concurrent_cap when maxConcurrentFromSchedule is hit', async () => {
    const schedule = makeSchedule({ maxConcurrentFromSchedule: 1 });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockSelectCount = 1;

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(body.created).toBe(0);

    const updateCall = taskSchedulesUpdateCalls.find(c =>
      c.set?.lastDeferralReason === 'concurrent_cap'
    );
    expect(updateCall).toBeDefined();
    expect(updateCall.set.lastDeferredAt).toBeInstanceOf(Date);
  });

  it('should clear lastDeferralReason when schedule fires successfully', async () => {
    const schedule = makeSchedule();
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);

    const updateCall = taskSchedulesUpdateCalls.find(c =>
      c.set?.lastDeferralReason === null && c.set?.lastDeferredAt === null
    );
    expect(updateCall).toBeDefined();
  });

  it('should record lastDeferralReason=active_hours when outside quiet hours', async () => {
    const { isWithinActiveHours } = await import('@/lib/mission-context');
    (isWithinActiveHours as ReturnType<typeof mock>).mockReturnValue(false);

    const schedule = makeSchedule({
      taskTemplate: {
        title: 'Heartbeat check',
        mode: 'execution',
        priority: 0,
        context: { heartbeat: true, activeHoursStart: 8, activeHoursEnd: 22 },
      },
    });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);

    const updateCall = taskSchedulesUpdateCalls.find(c =>
      c.set?.lastDeferralReason === 'active_hours'
    );
    expect(updateCall).toBeDefined();
    expect(updateCall.set.lastDeferredAt).toBeInstanceOf(Date);

    // Restore mock
    (isWithinActiveHours as ReturnType<typeof mock>).mockReturnValue(true);
  });

  // --- Mission cost-budget deferral ---
  //
  // A schedule under a mission that spent its cost budget must be DEFERRED,
  // not disabled: `budget_exhausted` is cleared by a human raising
  // costBudgetUsd (the auto-resume branch in api/missions/[id] flips the
  // mission back to `active`), and that branch does NOT re-enable schedules.
  // So a disabled schedule never fires again even after the budget is raised —
  // the mission just goes quiet forever with nothing in the response body or
  // on the schedule row to say why. Deferral keeps enabled=true, advances
  // nextRunAt, and records the reason MissionGrid renders.

  it('defers a schedule with lastDeferralReason=budget_exhausted when its mission spent its cost budget', async () => {
    const schedule = makeSchedule({ workspaceId: 'ws-1' });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue({
      id: 'mission-1',
      workspaceId: 'ws-1',
      status: 'budget_exhausted',
      maxConcurrentTasks: null,
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    // Deferred, not dispatched.
    expect(body.skipped).toBe(1);
    expect(body.created).toBe(0);
    expect(tasksInsertValues).toBeNull();

    const deferral = taskSchedulesUpdateCalls.find(c =>
      c.set?.lastDeferralReason === 'budget_exhausted'
    );
    expect(deferral).toBeDefined();
    expect(deferral.set.lastDeferredAt).toBeInstanceOf(Date);
    expect(deferral.set.nextRunAt).toBeInstanceOf(Date);

    // The schedule must stay enabled. Disabling it here is unrecoverable:
    // raising the budget resumes the mission but leaves enabled=false, and the
    // due-schedule query only ever looks at enabled=true rows.
    const disabled = taskSchedulesUpdateCalls.find(c => c.set?.enabled === false);
    expect(disabled).toBeUndefined();
  });

  it('dispatches the same schedule once the mission has budget room again', async () => {
    const schedule = makeSchedule({ workspaceId: 'ws-1' });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue({
      id: 'mission-1',
      workspaceId: 'ws-1',
      status: 'active',
      maxConcurrentTasks: null,
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.created).toBe(1);
    expect(body.skipped).toBe(0);
    expect(tasksInsertValues).not.toBeNull();
    expect(tasksInsertValues.missionId).toBe('mission-1');

    const deferral = taskSchedulesUpdateCalls.find(c =>
      c.set?.lastDeferralReason === 'budget_exhausted'
    );
    expect(deferral).toBeUndefined();
  });

  // --- Overdue heartbeat alerts ---

  function makeOverdueHeartbeatSchedule(overrides: Partial<any> = {}): any {
    return {
      id: 'sched-overdue',
      workspaceId: 'ws-1',
      name: 'Mission Heartbeat',
      cronExpression: '*/30 * * * *',
      enabled: true,
      nextRunAt: new Date(Date.now() - 90 * 60 * 1000),
      lastOverdueAlertAt: null,
      taskTemplate: {
        title: 'Heartbeat check',
        mode: 'execution',
        priority: 0,
        context: { heartbeat: true },
      },
      consecutiveFailures: 0,
      pauseAfterFailures: 5,
      lastError: null,
      maxConcurrentFromSchedule: 0,
      totalRuns: 0,
      totalChecks: 0,
      lastTriggerValue: null,
      oneShot: false,
      ...overrides,
    };
  }

  it('sends Pushover alert when a heartbeat is overdue by >2x its interval', async () => {
    // First call: main loop finds nothing due
    // Second call: overdue check finds the stuck heartbeat schedule
    mockTaskSchedulesFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeOverdueHeartbeatSchedule()]);

    mockIsOverdue.mockReturnValue(true);
    mockEstimateCronIntervalMs.mockReturnValue(30 * 60 * 1000);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', title: 'My Mission' });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.overdueHeartbeatAlerts).toBe(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      app: 'alerts',
      title: expect.stringContaining('My Mission'),
      message: expect.stringContaining('overdue'),
    }));

    const updateCall = taskSchedulesUpdateCalls.find(c => c.set?.lastOverdueAlertAt);
    expect(updateCall).toBeDefined();
    expect(updateCall.set.lastOverdueAlertAt).toBeInstanceOf(Date);
  });

  it('uses schedule name as fallback when no linked mission found', async () => {
    mockTaskSchedulesFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeOverdueHeartbeatSchedule({ name: 'Finance Heartbeat' })]);

    mockIsOverdue.mockReturnValue(true);
    mockMissionsFindFirst.mockResolvedValue(null); // no linked mission

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.overdueHeartbeatAlerts).toBe(1);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('Finance Heartbeat'),
    }));
  });

  it('does not alert when heartbeat schedule is not overdue', async () => {
    mockTaskSchedulesFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeOverdueHeartbeatSchedule()]);

    mockIsOverdue.mockReturnValue(false); // not overdue

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.overdueHeartbeatAlerts).toBe(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('does not alert when non-heartbeat schedule is overdue', async () => {
    const nonHeartbeatSchedule = makeSchedule({
      nextRunAt: new Date(Date.now() - 90 * 60 * 1000),
      taskTemplate: {
        title: 'Regular Task',
        mode: 'execution',
        priority: 0,
        // No heartbeat: true in context
      },
    });

    mockTaskSchedulesFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([nonHeartbeatSchedule]);

    mockIsOverdue.mockReturnValue(true);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.overdueHeartbeatAlerts).toBe(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('suppresses duplicate alerts within the same interval (dedup)', async () => {
    const intervalMs = 30 * 60 * 1000;
    const recentlyAlerted = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago

    mockTaskSchedulesFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeOverdueHeartbeatSchedule({ lastOverdueAlertAt: recentlyAlerted })]);

    mockIsOverdue.mockReturnValue(true);
    mockEstimateCronIntervalMs.mockReturnValue(intervalMs); // 30 min interval; 10 min < 30 min → suppress

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.overdueHeartbeatAlerts).toBe(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('re-alerts after a full interval has passed since last alert', async () => {
    const intervalMs = 30 * 60 * 1000;
    const oldAlert = new Date(Date.now() - 35 * 60 * 1000); // 35 min ago > 30 min interval

    mockTaskSchedulesFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeOverdueHeartbeatSchedule({ lastOverdueAlertAt: oldAlert })]);

    mockIsOverdue.mockReturnValue(true);
    mockEstimateCronIntervalMs.mockReturnValue(intervalMs);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', title: 'My Mission' });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.overdueHeartbeatAlerts).toBe(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });
});
