import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The goal-criteria quality shadow (lib/goal-criteria-quality-shadow.ts) runs
// for real after the response; only its decision call is stubbed, and gate
// rows are captured instead of reaching the table-agnostic db.insert mock.
const recordedGateEvents: any[] = [];
mock.module('@buildd/core/gate-events', () => ({
  GATE_SLUGS: new Proxy({}, { get: (_t, k) => String(k).toLowerCase() }),
  gateFrictionSignature: (gate: string, reason: string) => `gate:${gate}_${Buffer.from(reason).toString('hex').slice(0, 12)}`,
  recordGateEvent: async (input: any) => { recordedGateEvents.push(input); return null; },
  recordOrCoalesceDeferral: async () => null,
  recordOrCoalesceRepeat: async () => null,
}));
let goalQualityAccess: () => Promise<any> = async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'mission_goal_quality' } });
let goalQualityDecide: (req: any) => Promise<any> = async () => { throw new Error('decide not expected'); };
const goalQualityDecideCalls: any[] = [];
mock.module('@buildd/core/decision-client', () => ({
  resolveDecisionAccess: () => goalQualityAccess(),
  decisionCall: (req: any) => { goalQualityDecideCalls.push(req); return goalQualityDecide(req); },
}));

// Mock functions
const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockMissionsFindFirst = mock(() => ({
  id: '11111111-1111-4111-8111-111111111111',
  teamId: 'team-1',
  title: 'Existing Mission',
  workspaceId: 'ws-1',
  scheduleId: null,
  priority: 0,
}) as any);
const mockInitiativesFindFirst = mock(() => null as any);
// A per-task token's own task and worker, as the scope helpers read them.
const mockTasksFindFirst = mock((_args?: any) => Promise.resolve(null as any));
const mockWorkersFindFirst = mock((_args?: any) => Promise.resolve(null as any));
const mockWorkspacesFindFirst = mock(() => ({ id: 'ws-1' }) as any);
let updatedSetData: any = null;
const mockMissionsUpdate = mock(() => ({
  set: mock((data: any) => {
    updatedSetData = data;
    return {
      where: mock(() => ({
        returning: mock(() => [{ id: '11111111-1111-4111-8111-111111111111', ...data }]),
      })),
    };
  }),
}));

let insertedScheduleValues: any = null;
let updatedScheduleData: any = null;
let deletedTables: string[] = [];
const mockScheduleFindFirst = mock(() => null as any);
const mockScheduleUpdate = mock(() => ({
  set: mock((data: any) => {
    updatedScheduleData = data;
    return { where: mock(() => ({})) };
  }),
}));

// Mission-feed notes (postMissionFeedEvent). Kept separate from the schedule
// insert mock above — both route through db.insert(), and a shared capture
// var would have one clobber the other on any PATCH that triggers both.
let insertedNotes: any[] = [];
let recentCollapseNote: any = null;
const mockMissionNotesFindFirst = mock(() => Promise.resolve(recentCollapseNote));

// resolveCriteriaEscalation and escalateCriteriaFailure are the single
// writers for un-escalating / escalating a mission — each tested on its own
// in criteria-escalation.test.ts. Here we only assert the route calls the
// right one (or neither) at the right times, with the right arguments.
let resolveCriteriaEscalationCalls: Array<{ missionId: string; reason: string; actor: any }> = [];
const mockResolveCriteriaEscalation = mock((missionId: string, reason: string, actor: any) => {
  resolveCriteriaEscalationCalls.push({ missionId, reason, actor });
  return Promise.resolve({ cleared: true });
});
let escalateCriteriaFailureCalls: any[] = [];
const mockEscalateCriteriaFailure = mock((input: any) => {
  escalateCriteriaFailureCalls.push(input);
  return Promise.resolve({ escalated: true });
});
mock.module('@/lib/criteria-escalation', () => ({
  resolveCriteriaEscalation: mockResolveCriteriaEscalation,
  escalateCriteriaFailure: mockEscalateCriteriaFailure,
}));

const shippedStoreCalls: Array<{ missionId: string; opts: any }> = [];
mock.module('@/lib/mission-shipped-report', () => ({
  storeMissionShippedReportSafely: (missionId: string, opts: any) => {
    shippedStoreCalls.push({ missionId, opts });
    return Promise.resolve();
  },
}));

const mockEnsureMissionIntegrationBranch = mock(() =>
  Promise.resolve({ ok: true as const, branch: 'mission/existing-mission-11111111-1111-4111-8111-111111111111', created: true })
);
// wakeMission's own gating (manual / held / blocked) is covered in
// lib/mission-wake.test.ts; here only when the route asks for a wake.
const mockWakeMissionAfterResponse = mock((_id: string, _reason: string) => {});
mock.module('@/lib/mission-wake', () => ({
  wakeMission: mock(() => Promise.resolve({ woken: false, reason: 'not_found' })),
  wakeMissionAfterResponse: mockWakeMissionAfterResponse,
}));

const mockReportMissionBranchUnresolved = mock(async (_input: any) => {});
mock.module('@/lib/mission-integration-branch', () => ({
  ensureMissionIntegrationBranch: mockEnsureMissionIntegrationBranch,
  missionBranchRemedy: (reason: string) => `remedy for ${reason}`,
  reportMissionBranchUnresolved: mockReportMissionBranchUnresolved,
}));

// Mission-release wakes: one wakeTasks call per release, carrying the cause.
let wakeTasksCalls: Array<{ ids: string[]; cause: string }> = [];
let shouldDispatchReject = false;
const wokenIds = () => wakeTasksCalls.flatMap(c => c.ids);

const mockWakeTasks = mock(async (ids: readonly string[], cause: string) => {
  if (shouldDispatchReject) {
    throw new Error('Dispatch failed');
  }
  wakeTasksCalls.push({ ids: [...ids], cause });
});
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: async () => {},
  wakeTasks: mockWakeTasks,
  announceTaskCreated: async () => {},
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({}),
  deliverTaskDispatch: async () => 'skipped:test',
  routeForCause: () => ({}),
  webhookWants: () => false,
  primaryCause: (_c: readonly string[], fallback: string) => fallback,
  reseedDispatchTimer: async () => {},
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
}));

let missionTasksToReturn: any[] = [];
let shouldFindManyReject = false;
let tasksFindManyWhereCalls: any[] = [];
const mockTasksFindManyForExecutorChange = mock(async (options?: any) => {
  if (options && options.where) {
    tasksFindManyWhereCalls.push(options.where);
  }
  if (shouldFindManyReject) {
    throw new Error('tasks.findMany failed');
  }
  return missionTasksToReturn;
});

// The gate has its own suite (lib/mission-surface-audit-gate.test.ts); here it
// is a controllable verdict, so the route's refusal and waiver wiring is what is tested.
let surfaceGateVerdict: any = { required: false, why: 'no_ui_change' };
const mockEvaluateSurfaceAuditGate = mock(async (_m: any, _t: any) => surfaceGateVerdict);
mock.module('@/lib/mission-surface-audit-gate', () => ({
  evaluateSurfaceAuditGate: mockEvaluateSurfaceAuditGate,
  loadSurfaceAuditGateTasks: async () => [],
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  resolveAccountTeamIds: mockResolveAccountTeamIds,
}));

// Records the zone every recompute was asked for. A mission PATCH must never
// recompute nextRunAt against a hardcoded UTC — see docs/specs/timezone-resolution.md.
let computeNextRunAtCalls: Array<{ expr: string; timezone?: string }> = [];
mock.module('@/lib/schedule-helpers', () => ({
  computeNextRunAt: (expr: string, timezone?: string) => {
    computeNextRunAtCalls.push({ expr, timezone });
    return new Date('2026-01-01');
  },
}));

// The goal-criteria quality bypass check reads this mission's prior
// `goal_criteria_quality` rows; the only `db.select` the PATCH path makes.
let gateLedgerRows: Array<{ outcome: string; detail: unknown }> = [];
const gateLedgerReads: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({
      from: (table: any) => ({
        where: (cond: any) => ({
          orderBy: () => ({
            limit: () => { gateLedgerReads.push({ table, cond }); return Promise.resolve(gateLedgerRows); },
          }),
        }),
      }),
    }),
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      taskSchedules: { findFirst: mockScheduleFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      accountWorkspaces: { findFirst: mock(() => Promise.resolve(null)) },
      initiatives: { findFirst: mockInitiativesFindFirst },
      missionNotes: { findFirst: mockMissionNotesFindFirst },
      workers: { findFirst: (args: any) => mockWorkersFindFirst(args) },
      tasks: {
        findFirst: (args: any) => mockTasksFindFirst(args),
        findMany: mockTasksFindManyForExecutorChange,
      },
    },
    update: (table: any) => {
      if (table === 'taskSchedules') return mockScheduleUpdate();
      if (table === 'missionNotes') return { set: mock(() => ({ where: mock(() => Promise.resolve()) })) };
      return mockMissionsUpdate();
    },
    insert: (table: any) => ({
      values: mock((vals: any) => {
        if (table === 'missionNotes') {
          insertedNotes.push(vals);
          return { returning: mock(() => [{ id: `note-${insertedNotes.length}`, ...vals }]) };
        }
        insertedScheduleValues = vals;
        return {
          returning: mock(() => [{ id: 'sched-new', ...vals }]),
        };
      }),
    }),
    delete: (table: any) => ({
      where: (cond: any) => {
        deletedTables.push(typeof table === 'string' ? table : 'taskSchedules');
        return {};
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => args,
  desc: (field: any) => ({ field, type: 'desc' }),
  gte: (field: any, value: any) => ({ field, value, type: 'gte' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: 'missions',
  tasks: 'tasks',
  taskSchedules: 'taskSchedules',
  workspaces: { id: 'id', teamId: 'teamId' },
  initiatives: 'initiatives',
  missionNotes: 'missionNotes',
  workers: 'workers',
  gateEvents: { gate: 'gate', missionId: 'missionId', outcome: 'outcome', detail: 'detail', occurredAt: 'occurredAt' },
}));

import { GET, PATCH } from './route';
import { criterionFingerprint } from '@buildd/core/mission-helpers';

const makeParams = (id: string) => Promise.resolve({ id });

describe('PATCH /api/missions/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    mockMissionsUpdate.mockReset();
    mockScheduleFindFirst.mockReset();
    mockScheduleUpdate.mockReset();
    mockInitiativesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-1' });
    updatedSetData = null;
    insertedScheduleValues = null;
    updatedScheduleData = null;
    deletedTables = [];
    computeNextRunAtCalls = [];
    insertedNotes = [];
    recentCollapseNote = null;
    mockMissionNotesFindFirst.mockReset();
    mockMissionNotesFindFirst.mockImplementation(() => Promise.resolve(recentCollapseNote));
    mockEnsureMissionIntegrationBranch.mockReset();
    resolveCriteriaEscalationCalls = [];
    mockResolveCriteriaEscalation.mockClear();
    escalateCriteriaFailureCalls = [];
    mockEscalateCriteriaFailure.mockClear();
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: 'mission/existing-mission-11111111-1111-4111-8111-111111111111', created: true } as any);
    mockWakeMissionAfterResponse.mockClear();
    wakeTasksCalls = [];
    mockWakeTasks.mockClear();

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      priority: 0,
    });
    mockMissionsUpdate.mockImplementation(() => ({
      set: mock((data: any) => {
        // Merged, not overwritten: a completion request now issues a SECOND
        // `db.update(missions)` call for the flight-strip cache (Rule P-1)
        // alongside the main status write — see the top-level mock for why.
        updatedSetData = { ...updatedSetData, ...data };
        return {
          where: mock(() => ({
            returning: mock(() => [{ id: '11111111-1111-4111-8111-111111111111', ...data }]),
          })),
        };
      }),
    }));
    mockScheduleUpdate.mockImplementation(() => ({
      set: mock((data: any) => {
        updatedScheduleData = data;
        return { where: mock(() => ({})) };
      }),
    }));
  });

  // "Open" is open within the owning team: another team's open workspace
  // does not make its missions editable.
  it('404s a mission in another team\'s open workspace and writes nothing', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111', teamId: 'team-2', title: 'Theirs',
      workspaceId: 'ws-2', scheduleId: null, priority: 0,
    });
    mockWorkspacesFindFirst.mockReturnValue({ teamId: 'team-2', accessMode: 'open' });
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH', body: JSON.stringify({ title: 'Mine now' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(404);
    expect(updatedSetData).toBeNull();
  });

  it('404s a non-UUID id (e.g. a short 8-hex id) without querying the db', async () => {
    const req = new NextRequest('http://localhost/api/missions/a1b2c3d4', { method: 'PATCH' });
    const res = await PATCH(req, { params: makeParams('a1b2c3d4') });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('UUID');
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
  });

  it('stores heartbeat config in schedule template context', async () => {
    // Mission with existing schedule
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Health Check',
      workspaceId: 'ws-1',
      scheduleId: 'sched-1',
      priority: 0,
    });
    mockScheduleFindFirst.mockReturnValue({
      cronExpression: '0 */6 * * *',
      taskTemplate: { context: {} },
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        isHeartbeat: true,
        heartbeatChecklist: '- [ ] Check DB connections\n- [ ] Check queue depth',
      }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(updatedScheduleData).not.toBeNull();
    const ctx = updatedScheduleData.taskTemplate.context;
    expect(ctx.heartbeat).toBe(true);
    expect(ctx.heartbeatChecklist).toBe('- [ ] Check DB connections\n- [ ] Check queue depth');
  });

  it('stores active hours in schedule template context', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Monitor',
      workspaceId: 'ws-1',
      scheduleId: 'sched-1',
      priority: 0,
    });
    mockScheduleFindFirst.mockReturnValue({
      cronExpression: '0 * * * *',
      taskTemplate: { context: {} },
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        activeHoursStart: 8,
        activeHoursEnd: 20,
        activeHoursTimezone: 'Europe/London',
      }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    const ctx = updatedScheduleData.taskTemplate.context;
    expect(ctx.activeHoursStart).toBe(8);
    expect(ctx.activeHoursEnd).toBe(20);
    expect(ctx.activeHoursTimezone).toBe('Europe/London');
  });

  it('creates new schedule when adding cron to mission', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        cronExpression: '0 9 * * *',
        isHeartbeat: true,
      }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.cronExpression).toBe('0 9 * * *');
    expect(insertedScheduleValues.taskTemplate.context.heartbeat).toBe(true);
    // Schedule ID should be set on the objective
    expect(updatedSetData.scheduleId).toBe('sched-new');
  });

  // Regression: clearing startAt recomputed nextRunAt against a hardcoded 'UTC'
  // even for a schedule stored in another zone, silently shifting every run.
  it('recomputes nextRunAt in the schedule own stored zone when startAt is cleared', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Nightly',
      workspaceId: 'ws-1',
      scheduleId: 'sched-1',
      priority: 0,
    });
    mockScheduleFindFirst.mockReturnValue({
      cronExpression: '0 3 * * *',
      timezone: 'Asia/Tokyo',
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ startAt: null }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    const recompute = computeNextRunAtCalls.find((c) => c.expr === '0 3 * * *');
    expect(recompute).toBeDefined();
    expect(recompute!.timezone).toBe('Asia/Tokyo');
    expect(recompute!.timezone).not.toBe('UTC');
  });

  it('falls back to UTC when the schedule stores no zone', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Nightly',
      workspaceId: 'ws-1',
      scheduleId: 'sched-1',
      priority: 0,
    });
    mockScheduleFindFirst.mockReturnValue({ cronExpression: '0 3 * * *', timezone: null });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ startAt: null }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    const recompute = computeNextRunAtCalls.find((c) => c.expr === '0 3 * * *');
    expect(recompute!.timezone).toBe('UTC');
  });

  it('rejects activeHoursStart outside 0-23', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ activeHoursStart: 24 }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('activeHoursStart');
  });

  it('rejects activeHoursEnd outside 0-23', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ activeHoursEnd: -5 }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('activeHoursEnd');
  });

  it('updates workspaceId', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ workspaceId: 'ws-new' }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(updatedSetData).not.toBeNull();
    expect(updatedSetData.workspaceId).toBe('ws-new');
  });

  it('clears workspaceId with null', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ workspaceId: null }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(updatedSetData).not.toBeNull();
    expect(updatedSetData.workspaceId).toBeNull();
  });

  it('updates status to completed', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(updatedSetData.status).toBe('completed');
  });

  it('Rule P-1: an explicit completion computes and stores the flight-strip cache', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(updatedSetData.flightStripCache).toMatchObject({ bars: expect.any(Array), foldedBars: expect.any(Number) });
    // The status write is still visible — the two `db.update(missions)` calls
    // for one request merge in the mock, matching the real DB seeing both.
    expect(updatedSetData.status).toBe('completed');
  });

  it('an explicit completion stores a manual "what shipped" record with no author', async () => {
    shippedStoreCalls.length = 0;
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(shippedStoreCalls).toHaveLength(1);
    expect(shippedStoreCalls[0].missionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(shippedStoreCalls[0].opts).toMatchObject({ authorTaskId: null, origin: 'manual' });
  });

  it('does not store a "what shipped" record when the mission was already completed', async () => {
    shippedStoreCalls.length = 0;
    mockMissionsFindFirst.mockImplementationOnce(() => ({
      id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', title: 'Existing Mission', workspaceId: 'ws-1', scheduleId: null, priority: 0, status: 'completed',
    }) as any);
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 5 }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(shippedStoreCalls).toHaveLength(0);
  });

  it('does not compute a flight-strip cache when the mission was already completed', async () => {
    mockMissionsFindFirst.mockImplementationOnce(() => ({
      id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', title: 'Existing Mission', workspaceId: 'ws-1', scheduleId: null, priority: 0, status: 'completed',
    }) as any);
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 5 }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(updatedSetData.flightStripCache).toBeUndefined();
  });

  it('updates status to archived', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'archived' }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(updatedSetData.status).toBe('archived');
  });

  it('updates maxConcurrentTasks', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentTasks: 5 }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.maxConcurrentTasks).toBe(5);
  });

  it('clears maxConcurrentTasks with null', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentTasks: null }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.maxConcurrentTasks).toBeNull();
  });

  it('rejects maxConcurrentTasks < 1', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentTasks: 0 }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxConcurrentTasks');
  });

  it('rejects non-integer maxConcurrentTasks', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentTasks: 1.5 }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxConcurrentTasks');
  });

  it('rejects maxConcurrentTasks > 20', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentTasks: 21 }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxConcurrentTasks');
  });

  it('accepts maxConcurrentTasks = 20 (ceiling)', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentTasks: 20 }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
  });

  it('rejects invalid status', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'invalid' }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid status');
  });

  it('auto-deletes schedule when mission is completed', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: 'sched-1',
      priority: 0,
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.status).toBe('completed');
    expect(updatedSetData.scheduleId).toBeNull();
    expect(deletedTables).toContain('taskSchedules');
  });

  it('auto-deletes schedule when mission is archived', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: 'sched-1',
      priority: 0,
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'archived' }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.status).toBe('archived');
    expect(updatedSetData.scheduleId).toBeNull();
    expect(deletedTables).toContain('taskSchedules');
  });

  it('removes heartbeat flag from schedule context when isHeartbeat=false', async () => {
    // Regression: disabling heartbeat should remove the flag so MCP get no longer reports "Heartbeat: enabled"
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Monitor',
      workspaceId: 'ws-1',
      scheduleId: 'sched-1',
      priority: 0,
    });
    mockScheduleFindFirst.mockReturnValue({
      cronExpression: '0 * * * *',
      taskTemplate: { context: { heartbeat: true, heartbeatChecklist: '- [ ] Check stuff' } },
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ isHeartbeat: false }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedScheduleData).not.toBeNull();
    // heartbeat flag must be absent from the updated context
    expect(updatedScheduleData.taskTemplate.context.heartbeat).toBeUndefined();
  });

  it('disables (not deletes) schedule when mission is paused', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: 'sched-1',
      priority: 0,
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'paused' }),
    });

    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.status).toBe('paused');
    expect(updatedSetData.scheduleId).toBeUndefined();
    expect(updatedScheduleData?.enabled).toBe(false);
    expect(deletedTables).not.toContain('taskSchedules');
  });

  // ── Wake on resume / budget raise (event-driven replanning §2) ──────────
  const MID = '11111111-1111-4111-8111-111111111111';
  function existingWithStatus(status: string, extra: Record<string, unknown> = {}) {
    mockMissionsFindFirst.mockReturnValue({
      id: MID, teamId: 'team-1', title: 'Existing Mission', workspaceId: 'ws-1',
      scheduleId: 'sched-1', priority: 0, status, ...extra,
    });
  }
  function patch(body: Record<string, unknown>) {
    return PATCH(
      new NextRequest(`http://localhost/api/missions/${MID}`, { method: 'PATCH', body: JSON.stringify(body) }),
      { params: makeParams(MID) },
    );
  }

  it('wakes the mission when a paused mission is resumed', async () => {
    existingWithStatus('paused');
    const res = await patch({ status: 'active' });
    expect(res.status).toBe(200);
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledTimes(1);
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledWith(MID, 'resumed');
  });

  it('wakes the mission with budget_raised when a budget raise lifts budget_exhausted', async () => {
    existingWithStatus('budget_exhausted', { costBudgetUsd: '10' });
    const res = await patch({ costBudgetUsd: 20 });
    expect(res.status).toBe(200);
    expect(updatedSetData.status).toBe('active');
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledTimes(1);
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledWith(MID, 'budget_raised');
  });

  it('does not wake when the budget change leaves the mission exhausted', async () => {
    existingWithStatus('budget_exhausted', { costBudgetUsd: '10' });
    await patch({ costBudgetUsd: 5 });
    expect(mockWakeMissionAfterResponse).not.toHaveBeenCalled();
  });

  it('does not wake on pausing, or on an edit to an already-active mission', async () => {
    existingWithStatus('active');
    await patch({ status: 'paused' });
    await patch({ status: 'active' });
    await patch({ priority: 3 });
    expect(mockWakeMissionAfterResponse).not.toHaveBeenCalled();
  });

  it('rejects PATCH goalCriteria item without type field', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        goalCriteria: [{ description: 'All PRs merged' }],
      }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/goalCriteria\[0\]/);
  });

  it('rejects PATCH goalCriteria item with invalid type string', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        goalCriteria: [{ type: 'wrong_type' }],
      }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/goalCriteria\[0\]/);
  });

  it('accepts PATCH goalCriteria with valid types', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        goalCriteria: [
          { type: 'all_prs_merged' },
          { type: 'command', command: 'bun run test' },
        ],
      }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.goalCriteria).toEqual([
      { type: 'all_prs_merged' },
      { type: 'command', command: 'bun run test' },
    ]);
  });

  it('rejects a PATCH goalCriteria array with no mechanical criterion, naming the accepted types', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        goalCriteria: [{
          type: 'description',
          description: 'Ship the feature',
          notMechanizableReason: 'Feature completeness is a human judgement call here.',
        }],
      }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mechanical criterion/);
    expect(body.error).not.toContain('all_prs_merged + no_open_tasks');
    expect(body.error).toContain('command');
    expect(body.error).toContain('artifact_exists');
  });

  it('rejects a PATCH that removes the last mechanical criterion, leaving only description-type ones', async () => {
    const description = {
      type: 'description',
      description: 'Ship the feature',
      notMechanizableReason: 'Feature completeness is a human judgement call here.',
    };
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      priority: 0,
      goalCriteria: [description, { type: 'all_prs_merged' }],
    });
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ goalCriteria: [description] }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mechanical criterion/);
  });

  it('rejects a PATCH that adds a prose criterion with no stated reason', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({
        goalCriteria: [{ type: 'description', description: 'Ship the feature' }],
      }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/notMechanizableReason/);
  });

  it('accepts null goalCriteria to clear criteria', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ goalCriteria: null }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.goalCriteria).toBeNull();
  });

  it('accepts a valid mergePolicy', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ mergePolicy: { tier: 'auto-threshold', threshold: { maxLines: 500 } } }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.mergePolicy).toEqual({ tier: 'auto-threshold', threshold: { maxLines: 500 } });
  });

  it('accepts null mergePolicy to clear policy', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ mergePolicy: null }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.mergePolicy).toBeNull();
  });

  it('rejects mergePolicy with unknown keys (returns 400)', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ mergePolicy: { tier: 'human', unknownField: 'bad' } }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mergePolicy/);
  });

  it('rejects mergePolicy with invalid tier (returns 400)', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ mergePolicy: { tier: 'not-a-tier' } }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mergePolicy/);
  });

  it('rejects hand-written mergePolicy paths with a 400 that points to Re-scan repo', async () => {
    for (const [mergePolicy, field] of [
      [{ tier: 'agent-review', agentReview: { reviewerRole: 'r', escalateToPaths: ['infra/'] } }, 'mergePolicy.agentReview.escalateToPaths'],
      [{ tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } }, 'mergePolicy.threshold.denyPaths'],
    ] as const) {
      const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
        method: 'PATCH',
        body: JSON.stringify({ mergePolicy }),
      });
      const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.field).toBe(field);
      expect(body.error).toContain('Re-scan repo');
    }
  });

  it('accepts agent-review mergePolicy with required fields', async () => {
    const policy = { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } };
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ mergePolicy: policy }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.mergePolicy).toEqual(policy);
  });

  // Initiative assignment — team-scoped (not workspace-scoped)
  it('links an initiative in the same caller team', async () => {
    // Initiative lives in team-1, same team as caller — should succeed.
    mockInitiativesFindFirst.mockReturnValue({ id: 'init-1', teamId: 'team-1' });
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ initiativeId: 'init-1' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.initiativeId).toBe('init-1');
  });

  it('links an initiative from a different workspace but same caller team', async () => {
    // Mission is in ws-1 (team-1); initiative is also in team-1 but advisory workspaceId ws-other.
    // Caller belongs to team-1. Should succeed regardless of workspace mismatch.
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'sibling-app mission',
      workspaceId: 'ws-sibling-app',
      scheduleId: null,
      priority: 0,
    });
    mockInitiativesFindFirst.mockReturnValue({ id: 'init-buildd', teamId: 'team-1' });
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ initiativeId: 'init-buildd' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.initiativeId).toBe('init-buildd');
  });

  it('rejects an initiative not in any caller team', async () => {
    // Initiative belongs to team-2; caller only has access to team-1.
    mockInitiativesFindFirst.mockReturnValue({ id: 'init-other', teamId: 'team-2' });
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ initiativeId: 'init-other' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('initiative not found or not accessible');
  });

  it('rejects a non-existent initiativeId', async () => {
    mockInitiativesFindFirst.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ initiativeId: 'init-ghost' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('initiative not found or not accessible');
  });

  it('clears initiativeId with null', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ initiativeId: null }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);
    expect(updatedSetData.initiativeId).toBeNull();
  });

  describe('branchStrategy', () => {
    it('rejects an invalid branchStrategy value', async () => {
      const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
        method: 'PATCH',
        body: JSON.stringify({ branchStrategy: 'trunk' }),
      });
      const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('branchStrategy');
      expect(mockMissionsUpdate).not.toHaveBeenCalled();
    });

    it('branchStrategy=mission-branch sets integrationBranchEnabled and ensures the branch (opt-in transition)', async () => {
      const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
        method: 'PATCH',
        body: JSON.stringify({ branchStrategy: 'mission-branch' }),
      });
      const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
      expect(res.status).toBe(200);
      expect(updatedSetData.integrationBranchEnabled).toBe(true);
      expect(mockEnsureMissionIntegrationBranch).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    });

    it('branchStrategy=direct sets integrationBranchEnabled to false and never calls ensure', async () => {
      const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
        method: 'PATCH',
        body: JSON.stringify({ branchStrategy: 'direct' }),
      });
      const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
      expect(res.status).toBe(200);
      expect(updatedSetData.integrationBranchEnabled).toBe(false);
      expect(mockEnsureMissionIntegrationBranch).not.toHaveBeenCalled();
    });

    it('branchStrategy takes precedence over a raw integrationBranchEnabled in the same request', async () => {
      const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
        method: 'PATCH',
        body: JSON.stringify({ branchStrategy: 'direct', integrationBranchEnabled: true }),
      });
      const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
      expect(res.status).toBe(200);
      expect(updatedSetData.integrationBranchEnabled).toBe(false);
      expect(mockEnsureMissionIntegrationBranch).not.toHaveBeenCalled();
    });

    it('posts a feed note (never a silent success) when the remote ref cannot be created', async () => {
      mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: false, reason: 'api_error', detail: 'boom' } as any);
      const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
        method: 'PATCH',
        body: JSON.stringify({ branchStrategy: 'mission-branch' }),
      });
      const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
      expect(res.status).toBe(200);
      expect(updatedSetData.integrationBranchEnabled).toBe(true);
      const branchNote = insertedNotes.find(n => n.title === 'Integration branch could not be created');
      expect(branchNote).toBeDefined();
      expect(branchNote.body).toContain('api_error');
    });
  });
});

describe('PATCH /api/missions/[id] — mission feed', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    mockInitiativesFindFirst.mockReset();
    insertedNotes = [];
    recentCollapseNote = null;
    mockMissionNotesFindFirst.mockReset();
    mockMissionNotesFindFirst.mockImplementation(() => Promise.resolve(recentCollapseNote));
    mockEnsureMissionIntegrationBranch.mockReset();
    resolveCriteriaEscalationCalls = [];
    mockResolveCriteriaEscalation.mockClear();
    escalateCriteriaFailureCalls = [];
    mockEscalateCriteriaFailure.mockClear();
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: 'mission/existing-mission-11111111-1111-4111-8111-111111111111', created: true } as any);
    mockWakeMissionAfterResponse.mockClear();

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      status: 'active',
      priority: 0,
      goalCriteria: null,
    });
    mockMissionsUpdate.mockImplementation(() => ({
      set: mock((data: any) => {
        // Merged, not overwritten: a completion request now issues a SECOND
        // `db.update(missions)` call for the flight-strip cache (Rule P-1)
        // alongside the main status write — see the top-level mock for why.
        updatedSetData = { ...updatedSetData, ...data };
        return {
          where: mock(() => ({
            returning: mock(() => [{ id: '11111111-1111-4111-8111-111111111111', ...data }]),
          })),
        };
      }),
    }));
  });

  it('names both states and the actor when reopening a completed mission', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      status: 'completed',
      priority: 0,
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    const note = insertedNotes.find((n) => n.title === 'Mission reopened');
    expect(note).toBeDefined();
    expect(note.body).toBe('completed → active');
    expect(note.authorType).toBe('user');
    expect(note.actorLabel).toBe('user-1');
  });

  it('names a status change that is not a reopen distinctly', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'paused' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(insertedNotes.some((n) => n.title === 'Mission reopened')).toBe(false);
    const note = insertedNotes.find((n) => n.title === 'Mission status changed');
    expect(note).toBeDefined();
    expect(note.body).toBe('active → paused');
  });

  it('escalates (stamp + notify) exactly once when a never-escalated mission is force-completed with a failing verdict', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      status: 'active',
      priority: 0,
      goalCriteria: [{ type: 'no_open_tasks', label: 'No open tasks' }],
      goalCriteriaState: { overall: 'fail', evaluatedAt: '2026-01-01T00:00:00.000Z', criteria: [] },
      // criteriaEscalatedAt intentionally omitted — the heartbeat never escalated this
      // mission, e.g. it was force-completed before the N-cycle budget ran out.
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(escalateCriteriaFailureCalls).toHaveLength(1);
    expect(escalateCriteriaFailureCalls[0].missionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(escalateCriteriaFailureCalls[0].note.title).toBe('Goal criteria gate overridden');
    expect(escalateCriteriaFailureCalls[0].note.body).toContain('set to completed');
    expect(escalateCriteriaFailureCalls[0].note.body).toContain('fail');
    // Already the decision, not a question awaiting one — nothing more to answer.
    expect(escalateCriteriaFailureCalls[0].note.status).toBe('answered');
    // Never escalated before this request — resolveCriteriaEscalation must not also
    // fire, or it would immediately null the column this call just stamped.
    expect(resolveCriteriaEscalationCalls).toHaveLength(0);
  });

  it('escalates when archived directly while criteria are unverified — skipping "completed" must not skip the audit', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      status: 'active',
      priority: 0,
      goalCriteria: [{ type: 'no_open_tasks', label: 'No open tasks' }],
      goalCriteriaState: { overall: 'UNVERIFIED', evaluatedAt: '2026-01-01T00:00:00.000Z', criteria: [] },
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'archived' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(escalateCriteriaFailureCalls).toHaveLength(1);
    expect(escalateCriteriaFailureCalls[0].note.body).toContain('set to archived');
    expect(escalateCriteriaFailureCalls[0].note.body).toContain('UNVERIFIED');
  });

  it('records a plain override note (no re-escalation) when completing an already-escalated mission', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      status: 'active',
      priority: 0,
      goalCriteria: [{ type: 'no_open_tasks', label: 'No open tasks' }],
      goalCriteriaState: { overall: 'fail', evaluatedAt: '2026-01-01T00:00:00.000Z', criteria: [] },
      criteriaEscalatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    const note = insertedNotes.find((n) => n.title === 'Goal criteria gate overridden');
    expect(note).toBeDefined();
    expect(note.body).toContain('set to completed');
    expect(note.body).toContain('fail');
    // Already escalated — the note is a plain audit trail, not a fresh escalation.
    expect(escalateCriteriaFailureCalls).toHaveLength(0);
  });

  it('does not re-audit archiving a mission that already completed cleanly', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      status: 'completed',
      priority: 0,
      goalCriteria: [{ type: 'no_open_tasks', label: 'No open tasks' }],
      goalCriteriaState: { overall: 'fail', evaluatedAt: '2026-01-01T00:00:00.000Z', criteria: [] },
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'archived' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(insertedNotes.some((n) => n.title === 'Goal criteria gate overridden')).toBe(false);
    expect(escalateCriteriaFailureCalls).toHaveLength(0);
  });

  it('resolves the criteria escalation when a previously escalated mission is completed', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      status: 'active',
      priority: 0,
      goalCriteria: null,
      criteriaEscalatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(resolveCriteriaEscalationCalls).toHaveLength(1);
    expect(resolveCriteriaEscalationCalls[0]).toMatchObject({ missionId: '11111111-1111-4111-8111-111111111111', reason: 'mission_completed' });
  });

  it('resolves the criteria escalation when a previously escalated mission is archived', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      status: 'active',
      priority: 0,
      goalCriteria: null,
      criteriaEscalatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'archived' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(resolveCriteriaEscalationCalls).toHaveLength(1);
    expect(resolveCriteriaEscalationCalls[0]).toMatchObject({ missionId: '11111111-1111-4111-8111-111111111111', reason: 'mission_completed' });
  });

  it('resolves the criteria escalation with reason "waived" when a previously escalated mission is completed while criteria are still failing', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      status: 'active',
      priority: 0,
      goalCriteria: [{ type: 'no_open_tasks', label: 'No open tasks' }],
      goalCriteriaState: { overall: 'fail', evaluatedAt: '2026-01-01T00:00:00.000Z', criteria: [] },
      criteriaEscalatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(resolveCriteriaEscalationCalls).toHaveLength(1);
    expect(resolveCriteriaEscalationCalls[0]).toMatchObject({ missionId: '11111111-1111-4111-8111-111111111111', reason: 'waived' });
  });

  it('does not resolve a criteria escalation on completion when the mission was never escalated', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(resolveCriteriaEscalationCalls).toHaveLength(0);
  });

  it('does not resolve a criteria escalation on a status change that is not a close', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'paused' }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(resolveCriteriaEscalationCalls).toHaveLength(0);
  });

  it('resolves the criteria escalation when goalCriteria is edited', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ goalCriteria: [{ type: 'no_open_tasks', label: 'No open tasks' }] }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(resolveCriteriaEscalationCalls).toHaveLength(1);
    expect(resolveCriteriaEscalationCalls[0]).toMatchObject({ missionId: '11111111-1111-4111-8111-111111111111', reason: 'criteria_edited' });
  });

  it('does not resolve a criteria escalation on a PATCH that touches neither status nor goalCriteria', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 5 }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    expect(resolveCriteriaEscalationCalls).toHaveLength(0);
  });

  it('names each added goal criterion', async () => {
    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ goalCriteria: [{ type: 'no_open_tasks', label: 'No open tasks' }] }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    const note = insertedNotes.find((n) => n.title === 'Goal criterion added: No open tasks');
    expect(note).toBeDefined();
  });

  it('names a removed goal criterion', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      status: 'active',
      priority: 0,
      goalCriteria: [{ type: 'no_open_tasks', label: 'No open tasks' }],
    });

    const req = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ goalCriteria: [] }),
    });
    const res = await PATCH(req, { params: makeParams('11111111-1111-4111-8111-111111111111') });
    expect(res.status).toBe(200);

    const note = insertedNotes.find((n) => n.title === 'Goal criterion removed: No open tasks');
    expect(note).toBeDefined();
  });

  it('collapses repeated config edits from the same actor into one feed entry', async () => {
    const first = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 5 }),
    });
    await PATCH(first, { params: makeParams('11111111-1111-4111-8111-111111111111') });

    expect(insertedNotes.length).toBe(1);
    expect(insertedNotes[0].title).toBe('Mission configuration updated');
    expect(insertedNotes[0].body).toContain('priority: 0 → 5');

    // Simulate the collapse window: the note just inserted is "recent".
    recentCollapseNote = insertedNotes[0];

    const second = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ pacingMode: 'paced' }),
    });
    await PATCH(second, { params: makeParams('11111111-1111-4111-8111-111111111111') });

    // No second row inserted — the existing one was updated in place.
    expect(insertedNotes.length).toBe(1);
  });

  it('does not collapse status changes — each gets its own row even from the same actor', async () => {
    const first = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'paused' }),
    });
    await PATCH(first, { params: makeParams('11111111-1111-4111-8111-111111111111') });

    mockMissionsFindFirst.mockReturnValue({
      id: '11111111-1111-4111-8111-111111111111',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      status: 'paused',
      priority: 0,
    });
    const second = new NextRequest('http://localhost/api/missions/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    });
    await PATCH(second, { params: makeParams('11111111-1111-4111-8111-111111111111') });

    expect(insertedNotes.filter((n) => n.title === 'Mission status changed').length).toBe(2);
  });

});

describe('PATCH /api/missions/[id] — executor change: re-dispatch tasks', () => {
  const MID = '11111111-1111-4111-8111-111111111111';
  const WS_ID = 'ws-1';

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockReturnValue(null);
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockResolvedValue({ id: WS_ID, name: 'test-ws', repo: 'owner/repo' });
    mockMissionsUpdate.mockReset();
    mockMissionsUpdate.mockImplementation(() => ({
      set: mock((data: any) => {
        updatedSetData = { ...updatedSetData, ...data };
        return {
          where: mock(() => ({
            returning: mock(() => [{ id: MID, ...data }]),
          })),
        };
      }),
    }));
    updatedSetData = null;
    wakeTasksCalls = [];
    shouldDispatchReject = false;
    shouldFindManyReject = false;
    tasksFindManyWhereCalls = [];
    missionTasksToReturn = [];
  });

  it('re-dispatches pending tasks when executor changes from local to runner', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: MID,
      teamId: 'team-1',
      title: 'Local Mission',
      workspaceId: WS_ID,
      executor: 'local',
      scheduleId: null,
      priority: 0,
    });

    missionTasksToReturn = [
      {
        id: 'task-1',
        title: 'Task 1',
        description: 'Description 1',
        workspaceId: WS_ID,
        mode: 'planning',
        priority: 0,
        missionId: MID,
        defaultBackend: 'claude',
      },
      {
        id: 'task-2',
        title: 'Task 2',
        description: null,
        workspaceId: WS_ID,
        mode: 'coding',
        priority: 1,
        missionId: MID,
        defaultBackend: null,
      },
    ];

    const req = new NextRequest(`http://localhost/api/missions/${MID}`, {
      method: 'PATCH',
      body: JSON.stringify({ executor: 'runner' }),
    });

    const res = await PATCH(req, { params: makeParams(MID) });
    expect(res.status).toBe(200);

    // One wake for the mission's pending tasks, labelled as a release
    expect(wakeTasksCalls).toEqual([{ ids: ['task-1', 'task-2'], cause: 'mission.released' }]);
  });

  // The stranded card's "Continue on a runner" renders disabled with this same
  // reason (`continueOnRunnerBlockedReason`), so the tap is never offered and
  // then refused.
  it('refuses local → runner with 409 and the reason when the mission has no workspace', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: MID, teamId: 'team-1', title: 'Local Mission', workspaceId: null, executor: 'local', status: 'active', scheduleId: null, priority: 0,
    });
    const req = new NextRequest(`http://localhost/api/missions/${MID}`, {
      method: 'PATCH',
      body: JSON.stringify({ executor: 'runner' }),
    });
    const res = await PATCH(req, { params: makeParams(MID) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/no workspace/);
    expect(updatedSetData).toBeNull();
    expect(wakeTasksCalls.length).toBe(0);
  });

  it('accepts workspaceId + executor:runner in one PATCH on a workspace-less local mission', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: MID, teamId: 'team-1', title: 'Local Mission', workspaceId: null, executor: 'local', status: 'active', scheduleId: null, priority: 0,
    });
    const req = new NextRequest(`http://localhost/api/missions/${MID}`, {
      method: 'PATCH',
      body: JSON.stringify({ workspaceId: WS_ID, executor: 'runner' }),
    });
    const res = await PATCH(req, { params: makeParams(MID) });
    expect(res.status).not.toBe(409);
  });

  it('refuses local → runner on a completed mission', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: MID, teamId: 'team-1', title: 'Local Mission', workspaceId: WS_ID, executor: 'local', status: 'completed', scheduleId: null, priority: 0,
    });
    const req = new NextRequest(`http://localhost/api/missions/${MID}`, {
      method: 'PATCH',
      body: JSON.stringify({ executor: 'runner' }),
    });
    const res = await PATCH(req, { params: makeParams(MID) });
    expect(res.status).toBe(409);
    expect(updatedSetData).toBeNull();
  });

  it('does not re-dispatch when executor is unchanged', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: MID,
      teamId: 'team-1',
      title: 'Runner Mission',
      workspaceId: WS_ID,
      executor: 'runner',
      scheduleId: null,
      priority: 0,
    });

    missionTasksToReturn = [
      { id: 'task-1', title: 'Task 1', description: null, workspaceId: WS_ID, mode: 'planning', priority: 0, missionId: MID, defaultBackend: null },
    ];

    const req = new NextRequest(`http://localhost/api/missions/${MID}`, {
      method: 'PATCH',
      body: JSON.stringify({ executor: 'runner' }),
    });

    const res = await PATCH(req, { params: makeParams(MID) });
    expect(res.status).toBe(200);

    // No dispatch when executor is unchanged
    expect(wakeTasksCalls.length).toBe(0);
  });

  it('does not re-dispatch when executor changes from runner to local', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: MID,
      teamId: 'team-1',
      title: 'Runner Mission',
      workspaceId: WS_ID,
      executor: 'runner',
      scheduleId: null,
      priority: 0,
    });

    missionTasksToReturn = [
      { id: 'task-1', title: 'Task 1', description: null, workspaceId: WS_ID, mode: 'planning', priority: 0, missionId: MID, defaultBackend: null },
    ];

    const req = new NextRequest(`http://localhost/api/missions/${MID}`, {
      method: 'PATCH',
      body: JSON.stringify({ executor: 'local' }),
    });

    const res = await PATCH(req, { params: makeParams(MID) });
    expect(res.status).toBe(200);

    // No dispatch when changing runner -> local
    expect(wakeTasksCalls.length).toBe(0);
  });

  it('does not re-dispatch tasks in running or completed status', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: MID,
      teamId: 'team-1',
      title: 'Local Mission',
      workspaceId: WS_ID,
      executor: 'local',
      scheduleId: null,
      priority: 0,
    });

    // The route filters tasks by status, so only pending/assigned are returned
    missionTasksToReturn = [
      {
        id: 'task-pending',
        title: 'Pending Task',
        description: null,
        workspaceId: WS_ID,
        mode: 'planning',
        priority: 0,
        missionId: MID,
        defaultBackend: null,
      },
    ];

    const req = new NextRequest(`http://localhost/api/missions/${MID}`, {
      method: 'PATCH',
      body: JSON.stringify({ executor: 'runner' }),
    });

    const res = await PATCH(req, { params: makeParams(MID) });
    expect(res.status).toBe(200);

    // The route filters tasks by status, so running/completed tasks are never woken
    expect(wokenIds()).toEqual(['task-pending']);

    // Only `pending` is claimable; a wake for anything else is skipped at delivery.
    expect(tasksFindManyWhereCalls.length).toBeGreaterThan(0);
    const whereClause = tasksFindManyWhereCalls[0];
    expect(Array.isArray(whereClause)).toBe(true);
    const statusFilter = whereClause.find((cond: any) => cond.type === 'eq' && cond.value === 'pending');
    expect(statusFilter).toBeDefined();
  });

  it('returns 200 even if the wake rejects', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: MID,
      teamId: 'team-1',
      title: 'Local Mission',
      workspaceId: WS_ID,
      executor: 'local',
      scheduleId: null,
      priority: 0,
    });

    missionTasksToReturn = [
      {
        id: 'task-1',
        title: 'Task 1',
        description: null,
        workspaceId: WS_ID,
        mode: 'planning',
        priority: 0,
        missionId: MID,
        defaultBackend: null,
      },
    ];

    // Make the wake reject
    shouldDispatchReject = true;

    const req = new NextRequest(`http://localhost/api/missions/${MID}`, {
      method: 'PATCH',
      body: JSON.stringify({ executor: 'runner' }),
    });

    const res = await PATCH(req, { params: makeParams(MID) });

    // Should still return 200 despite dispatch failure
    expect(res.status).toBe(200);
    expect(updatedSetData.executor).toBe('runner');
  });

  it('returns 200 even if tasks.findMany fails', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: MID,
      teamId: 'team-1',
      title: 'Local Mission',
      workspaceId: WS_ID,
      executor: 'local',
      scheduleId: null,
      priority: 0,
    });

    // Make the findMany mock reject
    shouldFindManyReject = true;

    const req = new NextRequest(`http://localhost/api/missions/${MID}`, {
      method: 'PATCH',
      body: JSON.stringify({ executor: 'runner' }),
    });

    const res = await PATCH(req, { params: makeParams(MID) });

    // Should still return 200 despite tasks query failure
    expect(res.status).toBe(200);
    expect(updatedSetData.executor).toBe('runner');
    // No dispatch calls attempted since query failed
    expect(wakeTasksCalls.length).toBe(0);
  });

  it('wakes every task the pending query returned', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: MID,
      teamId: 'team-1',
      title: 'Local Mission',
      workspaceId: WS_ID,
      executor: 'local',
      scheduleId: null,
      priority: 0,
    });

    // The mock ignores the status filter, so this pins that the route wakes
    // whatever its query returned, in order
    missionTasksToReturn = [
      {
        id: 'task-pending',
        title: 'Pending Task',
        description: null,
        workspaceId: WS_ID,
        mode: 'planning',
        priority: 0,
        missionId: MID,
        defaultBackend: null,
      },
      {
        id: 'task-assigned',
        title: 'Assigned Task',
        description: null,
        workspaceId: WS_ID,
        mode: 'coding',
        priority: 1,
        missionId: MID,
        defaultBackend: 'claude',
      },
    ];

    const req = new NextRequest(`http://localhost/api/missions/${MID}`, {
      method: 'PATCH',
      body: JSON.stringify({ executor: 'runner' }),
    });

    const res = await PATCH(req, { params: makeParams(MID) });
    expect(res.status).toBe(200);

    expect(wokenIds()).toEqual(['task-pending', 'task-assigned']);
  });
  // Arming a held mission and raising an exhausted budget used to send no wake
  // at all: the tasks were already pending, so they waited for a runner poll.
  const base = { id: MID, teamId: 'team-1', title: 'M', workspaceId: WS_ID, executor: 'runner', scheduleId: null, priority: 0 };
  const send = (body: Record<string, unknown>) => PATCH(
    new NextRequest(`http://localhost/api/missions/${MID}`, { method: 'PATCH', body: JSON.stringify(body) }),
    { params: makeParams(MID) },
  );

  it.each([
    [{ arm: true }],
    [{ startMode: 'armed' }],
  ])('arming a held mission wakes its pending tasks as mission.released (%o)', async (body) => {
    mockMissionsFindFirst.mockReturnValue({ ...base, isHeld: true, status: 'active' });
    missionTasksToReturn = [{ id: 'task-1' }, { id: 'task-2' }];
    const res = await send(body);
    expect(res.status).toBe(200);
    expect(wakeTasksCalls).toEqual([{ ids: ['task-1', 'task-2'], cause: 'mission.released' }]);
  });

  it('arming a mission that was not held wakes nothing', async () => {
    mockMissionsFindFirst.mockReturnValue({ ...base, isHeld: false, status: 'active' });
    missionTasksToReturn = [{ id: 'task-1' }];
    await send({ arm: true });
    expect(wakeTasksCalls).toEqual([]);
  });

  it('holding a mission wakes nothing', async () => {
    mockMissionsFindFirst.mockReturnValue({ ...base, isHeld: false, status: 'active' });
    missionTasksToReturn = [{ id: 'task-1' }];
    await send({ startMode: 'held' });
    expect(wakeTasksCalls).toEqual([]);
  });

  it('raising an exhausted budget wakes its pending tasks as budget.available', async () => {
    mockMissionsFindFirst.mockReturnValue({ ...base, status: 'budget_exhausted', costBudgetUsd: '10' });
    missionTasksToReturn = [{ id: 'task-1' }];
    const res = await send({ costBudgetUsd: 20 });
    expect(res.status).toBe(200);
    expect(wakeTasksCalls).toEqual([{ ids: ['task-1'], cause: 'budget.available' }]);
  });

  it('a budget change that leaves the mission exhausted wakes nothing', async () => {
    mockMissionsFindFirst.mockReturnValue({ ...base, status: 'budget_exhausted', costBudgetUsd: '10' });
    missionTasksToReturn = [{ id: 'task-1' }];
    await send({ costBudgetUsd: 5 });
    expect(wakeTasksCalls).toEqual([]);
  });
});

describe('PATCH /api/missions/[id] — surface audit gate and waiver', () => {
  const MID = '11111111-1111-4111-8111-111111111111';
  const uiGate = { required: true, source: 'diff', uiPaths: ['apps/web/src/components/Card.tsx'] };
  const patch = (body: Record<string, unknown>) =>
    PATCH(new NextRequest(`http://localhost/api/missions/${MID}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: makeParams(MID) });

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    insertedNotes = [];
    updatedSetData = null;
    surfaceGateVerdict = { required: false, why: 'no_ui_change' };
    mockEvaluateSurfaceAuditGate.mockClear();
    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockMissionsFindFirst.mockReturnValue({
      id: MID, teamId: 'team-1', title: 'Existing Mission', workspaceId: 'ws-1', scheduleId: null,
      status: 'active', priority: 0, goalCriteria: null,
    });
    mockMissionsUpdate.mockImplementation(() => ({
      set: mock((data: any) => {
        updatedSetData = { ...updatedSetData, ...data };
        return { where: mock(() => ({ returning: mock(() => [{ id: MID, ...data }]) })) };
      }),
    }));
  });

  it('refuses a human completion of a UI mission with no audit, with an actionable reason', async () => {
    surfaceGateVerdict = uiGate;
    const res = await patch({ status: 'completed' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('surface_audit_missing');
    expect(body.error).toContain('apps/web/src/components/Card.tsx');
    expect(body.error).toContain('surfaceAuditWaiver');
    expect(updatedSetData).toBeNull();
  });

  it('a waiver supplied with the completion lets it through and records the reason', async () => {
    surfaceGateVerdict = uiGate;
    const res = await patch({ status: 'completed', surfaceAuditWaiver: 'Copy-only change, checked by hand' });
    expect(res.status).toBe(200);
    expect(updatedSetData.status).toBe('completed');
    const note = insertedNotes.find(n => n.title === 'Surface audit waived');
    expect(note).toBeDefined();
    expect(note.body).toBe('Copy-only change, checked by hand');
    expect(note.authorType).toBe('user');
  });

  it('a backend-only mission completes without a waiver', async () => {
    const res = await patch({ status: 'completed' });
    expect(res.status).toBe(200);
    expect(updatedSetData.status).toBe('completed');
    expect(insertedNotes.some(n => n.title === 'Surface audit waived')).toBe(false);
  });

  it('a mission the gate clears (audit present or already waived) completes', async () => {
    surfaceGateVerdict = { required: false, why: 'has_audit' };
    expect((await patch({ status: 'completed' })).status).toBe(200);
  });

  it('does not gate archiving, or a mission that is already closed', async () => {
    surfaceGateVerdict = uiGate;
    expect((await patch({ status: 'archived' })).status).toBe(200);

    mockMissionsFindFirst.mockReturnValue({
      id: MID, teamId: 'team-1', title: 'Existing Mission', workspaceId: 'ws-1', scheduleId: null,
      status: 'completed', priority: 0, goalCriteria: null,
    });
    expect((await patch({ status: 'completed' })).status).toBe(200);
  });

  it("the dashboard's waiver alone (no status change) records the reason and the person who set it", async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'owner@example.com' } as any);
    const res = await patch({ surfaceAuditWaiver: 'Mission branch cannot be captured by CI' });
    expect(res.status).toBe(200);
    const note = insertedNotes.find(n => n.title === 'Surface audit waived');
    expect(note).toMatchObject({ body: 'Mission branch cannot be captured by CI', authorType: 'user', actorLabel: 'owner@example.com' });
    expect(updatedSetData?.status).toBeUndefined();
  });

  it("a task's per-task token cannot set the waiver, and nothing is recorded", async () => {
    mockGetCurrentUser.mockReturnValue(null);
    mockAuthenticateApiKey.mockReturnValue({
      id: 'acct-1', name: 'key', level: 'admin', teamId: 'team-1',
      taskScope: { taskId: 'task-own', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 },
    } as any);
    const res = await PATCH(
      new NextRequest(`http://localhost/api/missions/${MID}`, {
        method: 'PATCH',
        body: JSON.stringify({ surfaceAuditWaiver: 'Not needed, nothing user-facing' }),
        headers: { authorization: 'Bearer bld_test' },
      }),
      { params: makeParams(MID) },
    );
    expect([403, 404]).toContain(res.status);
    expect(insertedNotes).toHaveLength(0);
    expect(updatedSetData).toBeNull();
  });

  it('rejects a waiver with no real reason', async () => {
    const res = await patch({ surfaceAuditWaiver: 'skip' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('surfaceAuditWaiver');
    expect(insertedNotes).toHaveLength(0);
  });

  it('rejects a waiver from an in-task agent', async () => {
    mockGetCurrentUser.mockReturnValue(null);
    mockAuthenticateApiKey.mockReturnValue({ id: 'acct-1', name: 'key', level: 'admin', teamId: 'team-1' } as any);
    const res = await PATCH(
      new NextRequest(`http://localhost/api/missions/${MID}`, {
        method: 'PATCH',
        body: JSON.stringify({ surfaceAuditWaiver: 'Not needed, nothing user-facing', actorWorkerId: 'worker-1' }),
        headers: { authorization: 'Bearer bld_test' },
      }),
      { params: makeParams(MID) },
    );
    
    expect(res.status).toBe(403);
    expect(insertedNotes).toHaveLength(0);
  });

  it('accepts a waiver from an admin API key acting for a person (MCP)', async () => {
    mockGetCurrentUser.mockReturnValue(null);
    mockAuthenticateApiKey.mockReturnValue({ id: 'acct-1', name: 'key', level: 'admin', teamId: 'team-1' } as any);
    const res = await PATCH(
      new NextRequest(`http://localhost/api/missions/${MID}`, {
        method: 'PATCH',
        body: JSON.stringify({ surfaceAuditWaiver: 'Not needed, nothing user-facing' }),
        headers: { authorization: 'Bearer bld_test' },
      }),
      { params: makeParams(MID) },
    );
    expect(res.status).toBe(200);
    expect(insertedNotes.find(n => n.title === 'Surface audit waived')?.authorType).toBe('mcp');
  });
});

describe('PATCH /api/missions/[id] — goal-criteria quality shadow (docs/specs/mission-goal-criteria-quality.md)', () => {
  const MID = '11111111-1111-4111-8111-111111111111';
  const strong = { type: 'command', command: 'bun run e2e signup', label: 'a visitor can sign up' };
  const patch = (body: Record<string, unknown>) =>
    PATCH(new NextRequest(`http://localhost/api/missions/${MID}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: makeParams(MID) });
  const allowed = async () => ({ ok: true, apiKey: 'k', model: 'jev-test' });
  /** Grades a criterion labelled "...tests pass" as not noticeable; everything else as an outcome. */
  const grading = async (req: any) => {
    const answers: Record<string, unknown> = {};
    for (const name of Object.keys(req.questions)) {
      const i = Number(/^c(\d+)_/.exec(name)?.[1]);
      const weak = Number.isFinite(i) && /tests pass$/.test(req.state.criteria[i]?.label ?? '');
      answers[name] = { type: 'choice', confidence: 0.95, probabilities: {}, choice: name === 'rewrite' ? 'state-outcome' : weak ? 'no' : 'yes' };
    }
    return { ok: true, answers, model: 'jev-test', latencyMs: 4, usage: null, attempts: 1 };
  };
  const flush = () => new Promise(r => setTimeout(r, 20));
  const quality = () => recordedGateEvents.filter(e => e.gate === 'goal_criteria_quality');

  beforeEach(() => {
    recordedGateEvents.length = 0;
    goalQualityDecideCalls.length = 0;
    gateLedgerRows = [];
    gateLedgerReads.length = 0;
    goalQualityAccess = allowed;
    goalQualityDecide = grading;
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-1', dataClass: 'standard' });
    insertedNotes = [];
    updatedSetData = null;
    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockMissionsFindFirst.mockReturnValue({
      id: MID, teamId: 'team-1', title: 'Existing Mission', workspaceId: 'ws-1', scheduleId: null,
      status: 'active', priority: 0, goalCriteria: [strong],
    });
    mockMissionsUpdate.mockImplementation(() => ({
      set: mock((data: any) => {
        updatedSetData = { ...updatedSetData, ...data };
        return { where: mock(() => ({ returning: mock(() => [{ id: MID, ...data }]) })) };
      }),
    }));
  });

  it('byte-identical criteria make no decision call (AC-14)', async () => {
    const res = await patch({ goalCriteria: [strong] });
    expect(res.status).toBe(200);
    await flush();
    expect(goalQualityDecideCalls).toHaveLength(0);
  });

  it('keeping a warned criterion records one bypassed row, matched by fingerprint, even with the capability off (AC-8)', async () => {
    const weak = { type: 'command', command: 'bun run test', label: 'kept: tests pass' };
    mockMissionsFindFirst.mockReturnValue({
      id: MID, teamId: 'team-1', title: 'Existing Mission', workspaceId: 'ws-1', scheduleId: null,
      status: 'active', priority: 0, goalCriteria: [strong, weak],
    });
    goalQualityAccess = async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'mission_goal_quality' } });
    gateLedgerRows = [{ outcome: 'warned', detail: { fingerprint: criterionFingerprint(weak as any), mode: 'shadow' } }];
    // Reordered: index is not identity.
    const res = await patch({ goalCriteria: [weak, strong] });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('advisory');
    await flush();
    expect(gateLedgerReads).toHaveLength(1);
    expect(goalQualityDecideCalls).toHaveLength(0);
    const rows = quality();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'bypassed', surface: 'PATCH /api/missions/[id]', missionId: MID, detail: { fingerprint: criterionFingerprint(weak as any), mode: 'shadow' } });
    expect(JSON.stringify(rows[0])).not.toContain('tests pass');

    // A further PATCH that still keeps it: the ledger now holds the bypass.
    recordedGateEvents.length = 0;
    gateLedgerRows = [...gateLedgerRows, { outcome: 'bypassed', detail: { fingerprint: criterionFingerprint(weak as any) } }];
    await patch({ goalCriteria: [weak, strong] });
    await flush();
    expect(quality()).toEqual([]);
  });

  it('changing a warned criterion records no bypassed row (AC-9)', async () => {
    const weak = { type: 'command', command: 'bun run test', label: 'changed: tests pass' };
    gateLedgerRows = [{ outcome: 'warned', detail: { fingerprint: criterionFingerprint(weak as any), mode: 'shadow' } }];
    goalQualityAccess = async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'mission_goal_quality' } });
    await patch({ goalCriteria: [strong, { ...weak, label: 'changed: an owner can export a CSV' }] });
    await flush();
    expect(quality()).toEqual([]);
  });

  it('a PATCH without goalCriteria makes no decision call', async () => {
    await patch({ priority: 3 });
    await flush();
    expect(goalQualityDecideCalls).toHaveLength(0);
  });

  it('grades only the added criterion, records one warned row, and leaves the response and stored goal alone (AC-4, AC-7, AC-12)', async () => {
    const criteria = [strong, { type: 'command', command: 'bun run test', label: 'patch: tests pass' }];
    goalQualityAccess = async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'mission_goal_quality' } });
    const off = await (await patch({ goalCriteria: criteria })).json();
    await flush();
    goalQualityAccess = allowed;
    const res = await patch({ goalCriteria: criteria });
    expect(res.status).toBe(200);
    const on = await res.json();
    // Surface mode: response includes advisory field
    expect(on.advisory).toBeDefined();
    expect(typeof on.advisory.suggestion).toBe('string');
    expect(Array.isArray(on.advisory.criteria)).toBe(true);
    // But the stored goal criteria is untouched
    expect(updatedSetData.goalCriteria).toEqual(criteria);
    // Goal criteria itself is unchanged in response
    expect(on.goalCriteria).toEqual(criteria);
    await flush();
    expect(goalQualityDecideCalls).toHaveLength(1);
    expect(goalQualityDecideCalls[0].state.criteria).toEqual([{ type: 'command', label: 'patch: tests pass' }]);
    const rows = quality();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'warned', surface: 'PATCH /api/missions/[id]', missionId: MID, detail: { index: 1 } });
    expect(JSON.stringify(rows[0])).not.toContain('tests pass');
  });

  it('a strong added criterion records no warned row', async () => {
    await patch({ goalCriteria: [strong, { type: 'command', command: 'bun run e2e export', label: 'patch: an owner can export a CSV' }] });
    await flush();
    expect(goalQualityDecideCalls).toHaveLength(1);
    expect(quality()).toEqual([]);
  });

  it('a sensitive workspace sends nothing (AC-5)', async () => {
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-1', dataClass: 'sensitive' });
    await patch({ goalCriteria: [strong, { type: 'command', command: 'bun run test', label: 'sensitive: tests pass' }] });
    await flush();
    expect(goalQualityDecideCalls).toHaveLength(0);
    expect(quality()).toEqual([]);
  });

  it('a never-resolving or throwing decision call cannot delay or fail the PATCH (AC-2)', async () => {
    goalQualityDecide = () => new Promise(() => {});
    expect((await patch({ goalCriteria: [strong, { type: 'command', command: 'bun run test', label: 'hang: tests pass' }] })).status).toBe(200);
    goalQualityDecide = async () => { throw new Error('provider down'); };
    expect((await patch({ goalCriteria: [strong, { type: 'command', command: 'bun run test', label: 'throw: tests pass' }] })).status).toBe(200);
    await flush();
    expect(quality()).toEqual([]);
  });
});

describe("/api/missions/[id] — an orchestration task's admin per-task token", () => {
  const MISSION = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const taskScope = { taskId: 'task-own', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 };
  const ADMIN_TOKEN = { id: 'acct-1', teamId: 'team-1', level: 'admin', scopes: null, workspaceIds: null, taskScope };
  const patch = (body: Record<string, unknown>, id = MISSION) => PATCH(
    new NextRequest(`http://localhost/api/missions/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { authorization: 'Bearer bld_key' } }),
    { params: makeParams(id) },
  );

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockReturnValue(null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(ADMIN_TOKEN);
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue({ missionId: MISSION, workspaceId: 'ws-1', mission: { initiativeId: null } });
    mockWorkersFindFirst.mockReset();
    mockWorkersFindFirst.mockResolvedValue({ taskId: 'task-own', accountId: 'acct-1' });
    mockMissionsFindFirst.mockReset();
    mockMissionsFindFirst.mockReturnValue({ id: MISSION, teamId: 'team-1', title: 'Mine', workspaceId: 'ws-1', scheduleId: null, priority: 0, status: 'active' });
    updatedSetData = null;
    mockMissionsUpdate.mockReset();
    mockMissionsUpdate.mockImplementation(() => ({
      set: mock((data: any) => {
        updatedSetData = { ...updatedSetData, ...data };
        return { where: mock(() => ({ returning: mock(() => [{ id: MISSION, ...data }]) })) };
      }),
    }));
  });

  it("edits its own task's mission's descriptive fields", async () => {
    const res = await patch({ description: 'Sharper brief', priority: 3, actorWorkerId: 'worker-own' });
    expect(res.status).toBe(200);
    expect(updatedSetData.description).toBe('Sharper brief');
  });

  it('is refused every other field, naming it, and writes nothing', async () => {
    for (const body of [
      { workspaceId: 'ws-2' }, { initiativeId: 'i-1' }, { costBudgetUsd: 1000 }, { maxConcurrentTasks: 50 },
      { cronExpression: '* * * * *' }, { executor: 'local' }, { model: 'x' }, { mergePolicy: {} }, { branchStrategy: 'direct' },
      { goalCriteria: [] }, { dependsOnMission: OTHER }, { surfaceAuditWaiver: 'no visual change in this mission at all' },
      { description: 'ok', backend: 'codex' },
    ]) {
      const res = await patch(body);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain(Object.keys(body).at(-1)!);
    }
    expect(updatedSetData).toBeNull();
  });

  it("is refused a feed entry attributed to another task's worker", async () => {
    mockWorkersFindFirst.mockResolvedValue({ taskId: 'task-other', accountId: 'acct-1' });
    expect((await patch({ description: 'x', actorWorkerId: 'worker-other' })).status).toBe(403);
    expect(updatedSetData).toBeNull();
  });

  it('is refused another mission, before reading it', async () => {
    expect((await patch({ description: 'x' }, OTHER)).status).toBe(404);
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
    const res = await GET(new NextRequest(`http://localhost/api/missions/${OTHER}`, { headers: { authorization: 'Bearer bld_key' } }), { params: makeParams(OTHER) });
    expect(res.status).toBe(404);
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
  });

  it('a worker-level task token is refused even its own mission', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...ADMIN_TOKEN, level: 'worker' });
    expect((await patch({ description: 'x' })).status).toBe(404);
    const res = await GET(new NextRequest(`http://localhost/api/missions/${MISSION}`, { headers: { authorization: 'Bearer bld_key' } }), { params: makeParams(MISSION) });
    expect(res.status).toBe(404);
    expect(updatedSetData).toBeNull();
  });

  it('an admin account key is unaffected: it may still change any field', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'admin', scopes: null });
    expect((await patch({ maxConcurrentTasks: 4 })).status).toBe(200);
    expect(updatedSetData.maxConcurrentTasks).toBe(4);
  });
});
