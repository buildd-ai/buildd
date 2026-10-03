import { describe, it, expect, beforeEach, mock } from 'bun:test';
// The gate ledger shares the `db` handle with the route, so an unstubbed
// `recordGateEvent` shows up as an extra `db.insert` in the table-agnostic
// mocks below. Stubbed here because this file asserts route BEHAVIOUR; the
// ledger's own wiring is covered by gate-ledger.test.ts / the gate-events and
// gate-analytics suites in packages/core.
const recordedGateEvents: any[] = [];
mock.module('@buildd/core/gate-events', () => ({
  GATE_SLUGS: new Proxy({}, { get: (_t, k) => String(k).toLowerCase() }),
  gateFrictionSignature: (gate: string, reason: string) => `gate:${gate}_${Buffer.from(reason).toString('hex').slice(0, 12)}`,
  recordGateEvent: async (input: any) => { recordedGateEvents.push(input); return null; },
  recordOrCoalesceDeferral: async () => null,
}));
// The goal-criteria quality shadow (lib/goal-criteria-quality-shadow.ts) runs
// for real after the response; only its decision call is stubbed here.
let goalQualityAccess: () => Promise<any> = async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'mission_goal_quality' } });
let goalQualityDecide: (req: any) => Promise<any> = async () => { throw new Error('decide not expected'); };
const goalQualityDecideCalls: any[] = [];
mock.module('@buildd/core/decision-client', () => ({
  resolveDecisionAccess: () => goalQualityAccess(),
  decisionCall: (req: any) => { goalQualityDecideCalls.push(req); return goalQualityDecide(req); },
}));
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockMissionsFindMany = mock(() => [] as any[]);
const mockMissionsCount = mock(() => Promise.resolve(0));
const mockInitiativesFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => ({ id: 'ws-1' }) as any);
// accountWorkspaces lookups made by the real workspace-access resolver.
const mockAccountWorkspacesFindMany = mock(() => Promise.resolve([] as any[]));
const mockAccountWorkspacesFindFirst = mock(() => Promise.resolve(undefined as any));
const mockRunMission = mock(() => Promise.resolve({ task: { id: 'organizer-task-1' } }));
let insertedMissionValues: any = null;
let insertedScheduleValues: any = null;
const mockMissionsInsert = mock(() => ({
  values: mock((vals: any) => {
    insertedMissionValues = vals;
    return {
      returning: mock(() => [{ id: 'obj-1', ...vals }]),
    };
  }),
}));
const mockSchedulesInsert = mock(() => ({
  values: mock((vals: any) => {
    insertedScheduleValues = vals;
    return {
      returning: mock(() => [{ id: 'sched-1', ...vals }]),
    };
  }),
}));
let updatedMissionValues: any = null;
let scheduleLinkValues: any = null;
const mockMissionsUpdate = mock(() => ({
  set: mock((vals: any) => {
    // Linking the check-in schedule is its own update; keep it apart so the
    // branch-strategy tests still see only the working-branch write.
    if ('scheduleId' in vals) scheduleLinkValues = vals;
    else updatedMissionValues = vals;
    return {
      where: mock(() => ({
        returning: mock(() => []),
      })),
    };
  }),
}));

const mockEnsureMissionIntegrationBranch = mock(() =>
  Promise.resolve({ ok: true as const, branch: 'mission/x-00000000', created: true })
);
const mockResolveFeedActor = mock(() => Promise.resolve({ kind: 'system', id: null, label: 'system' } as any));
const mockPostMissionFeedEvent = mock(() => Promise.resolve());

const mockReportMissionBranchUnresolved = mock(async (_input: any) => {});
mock.module('@/lib/mission-integration-branch', () => ({
  ensureMissionIntegrationBranch: mockEnsureMissionIntegrationBranch,
  missionBranchRemedy: (reason: string) => `remedy for ${reason}`,
  reportMissionBranchUnresolved: mockReportMissionBranchUnresolved,
}));

mock.module('@/lib/mission-feed', () => ({
  resolveFeedActor: mockResolveFeedActor,
  postMissionFeedEvent: mockPostMissionFeedEvent,
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

mock.module('@/lib/schedule-helpers', () => ({
  computeNextRunAt: () => new Date('2026-01-01'),
}));

mock.module('@/lib/mission-run', () => ({
  runMission: mockRunMission,
}));

mock.module('@/lib/work-tracker', () => ({
  maybePostWorkTrackerNote: mock(() => Promise.resolve()),
  postLinearCompletionComment: mock(() => Promise.resolve()),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findMany: mockMissionsFindMany },
      initiatives: { findFirst: mockInitiativesFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany, findFirst: mockAccountWorkspacesFindFirst },
    },
    insert: (table: any) => {
      if (table === 'missions') return mockMissionsInsert();
      if (table === 'taskSchedules') return mockSchedulesInsert();
      return mockMissionsInsert();
    },
    update: () => mockMissionsUpdate(),
    $count: (...args: any[]) => (mockMissionsCount as any)(...args),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => args,
  or: (...args: any[]) => ({ args, type: 'or' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  notInArray: (field: any, values: any[]) => ({ field, values, type: 'notInArray' }),
  ilike: (field: any, value: any) => ({ field, value, type: 'ilike' }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings: [...strings], values, type: 'sql' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: 'missions',
  initiatives: { id: 'id', teamId: 'teamId' },
  workspaces: { id: 'id', teamId: 'teamId', accessMode: 'accessMode', repo: 'repo', name: 'name' },
  accountWorkspaces: { accountId: 'accountId', workspaceId: 'workspaceId', canClaim: 'canClaim', canCreate: 'canCreate' },
  taskSchedules: 'taskSchedules',
}));

import { GET, POST } from './route';

describe('POST /api/missions', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsInsert.mockReset();
    mockSchedulesInsert.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockInitiativesFindFirst.mockReset();
    mockInitiativesFindFirst.mockResolvedValue(null);
    mockRunMission.mockReset();
    mockEnsureMissionIntegrationBranch.mockReset();
    mockResolveFeedActor.mockReset();
    mockPostMissionFeedEvent.mockReset();
    insertedMissionValues = null;
    insertedScheduleValues = null;
    updatedMissionValues = null;
    scheduleLinkValues = null;

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-1', teamId: 'team-1' });
    mockRunMission.mockResolvedValue({ task: { id: 'organizer-task-1' } });
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: 'mission/x-00000000', created: true } as any);
    mockResolveFeedActor.mockResolvedValue({ kind: 'system', id: null, label: 'system' } as any);
    mockPostMissionFeedEvent.mockResolvedValue(undefined as any);

    mockMissionsInsert.mockImplementation(() => ({
      values: mock((vals: any) => {
        insertedMissionValues = vals;
        return {
          returning: mock(() => [{ id: 'obj-1', ...vals }]),
        };
      }),
    }));

    mockSchedulesInsert.mockImplementation(() => ({
      values: mock((vals: any) => {
        insertedScheduleValues = vals;
        return {
          returning: mock(() => [{ id: 'sched-1', ...vals }]),
        };
      }),
    }));
  });

  it('creates a mission with schedule containing heartbeat config', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Health Check',
        workspaceId: 'ws-1',
        cronExpression: '0 */6 * * *',
        isHeartbeat: true,
        heartbeatChecklist: '- [ ] Check API latency\n- [ ] Check error rates',
        activeHoursStart: 9,
        activeHoursEnd: 17,
        activeHoursTimezone: 'America/New_York',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // Mission should NOT have heartbeat fields
    expect(insertedMissionValues).not.toBeNull();
    expect(insertedMissionValues.isHeartbeat).toBeUndefined();
    expect(insertedMissionValues.heartbeatChecklist).toBeUndefined();

    // Schedule template context should have heartbeat config
    expect(insertedScheduleValues).not.toBeNull();
    const ctx = insertedScheduleValues.taskTemplate.context;
    expect(ctx.heartbeat).toBe(true);
    expect(ctx.heartbeatChecklist).toBe('- [ ] Check API latency\n- [ ] Check error rates');
    expect(ctx.activeHoursStart).toBe(9);
    expect(ctx.activeHoursEnd).toBe(17);
    expect(ctx.activeHoursTimezone).toBe('America/New_York');
  });

  it('UI-created auto mission (session auth, no cron, no isHeartbeat) gets a check-in schedule by default', async () => {
    // Events plan the next step; the check-in is the hourly stuck check that
    // recovers a mission whose event chain broke (event-driven-mission-replanning.md).
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Ship auth module' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedMissionValues).not.toBeNull();
    expect(insertedMissionValues.title).toBe('Ship auth module');
    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.cronExpression).toBe('0 * * * *');
    expect(insertedScheduleValues.taskTemplate.context.heartbeat).toBe(true);
    expect(scheduleLinkValues?.scheduleId).toBe('sched-1');
  });

  it('UI-created manual mission gets no default check-in schedule', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Owner-driven', orchestrationMode: 'manual' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedScheduleValues).toBeNull();
  });

  // The pre-filed-task heuristic in runMission() only ever sees tasks filed
  // BEFORE this same create request — it runs runMission() synchronously as
  // part of mission creation, before the caller has had a chance to file
  // anything. decomposition:"none" lets a creator who is about to file the
  // task chain itself say so up front, persisted before the organizer's
  // planning task exists (see the create insert values below).
  it('decomposition:"none" sets decompositionSkipped=true on the mission row at create time', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Pre-filed by creator', orchestrationMode: 'auto', decomposition: 'none' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues).not.toBeNull();
    expect(insertedMissionValues.decompositionSkipped).toBe(true);
  });

  it('decomposition:"auto" (default) does not set decompositionSkipped at create time', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Let the organizer decompose' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues).not.toBeNull();
    expect(insertedMissionValues.decompositionSkipped).toBeUndefined();
  });

  it('rejects an invalid decomposition value', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Bad value', decomposition: 'skip-everything' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/decomposition/i);
  });

  it('API-created mission auto-enables heartbeat without default active hours (opt-in)', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue({ id: 'api-1', level: 'admin', teamId: 'team-1' } as any);

    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      headers: { authorization: 'Bearer bld_test' },
      body: JSON.stringify({ title: 'API heartbeat mission' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // Schedule auto-created with heartbeat but no default active hours
    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.cronExpression).toBe('0 * * * *');
    const ctx = insertedScheduleValues.taskTemplate.context;
    expect(ctx.heartbeat).toBe(true);
    expect(ctx.heartbeatChecklist).toBeDefined();
    expect(ctx.activeHoursStart).toBeUndefined();
    expect(ctx.activeHoursEnd).toBeUndefined();
    expect(ctx.activeHoursTimezone).toBeUndefined();
  });

  it('creates a deferred mission active but inert until startAt', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue({ id: 'api-1', level: 'admin', teamId: 'team-1' } as any);
    const before = Date.now();

    const res = await POST(new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      headers: { authorization: 'Bearer bld_test' },
      body: JSON.stringify({ title: 'Deferred mission', startIn: '3h' }),
    }));

    expect(res.status).toBe(201);
    expect(insertedMissionValues.status).toBe('active');
    expect(insertedMissionValues.startAt.getTime()).toBeGreaterThanOrEqual(before + 3 * 60 * 60 * 1000);
    expect(insertedScheduleValues.nextRunAt).toEqual(insertedMissionValues.startAt);
    expect(mockRunMission).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.startAt).toBe(insertedMissionValues.startAt.toISOString());
  });

  it('UI-created mission with explicit cronExpression creates schedule', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Scheduled UI mission', cronExpression: '0 */6 * * *' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.cronExpression).toBe('0 */6 * * *');
  });

  it('UI-created mission with explicit isHeartbeat: true creates heartbeat schedule', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Heartbeat UI mission', isHeartbeat: true }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedScheduleValues).not.toBeNull();
    const ctx = insertedScheduleValues.taskTemplate.context;
    expect(ctx.heartbeat).toBe(true);
  });

  it('stores defaultBackend when a valid backend is provided', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Codex mission', backend: 'codex' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues).not.toBeNull();
    expect(insertedMissionValues.defaultBackend).toBe('codex');
  });

  it('omits defaultBackend when no backend is provided', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Default mission' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues).not.toBeNull();
    expect(insertedMissionValues.defaultBackend).toBeUndefined();
  });

  it('ignores an invalid backend value', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Bad backend', backend: 'gpt' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues.defaultBackend).toBeUndefined();
  });

  it('creates mission without heartbeat when explicitly opted out', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'No heartbeat', isHeartbeat: false }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedMissionValues).not.toBeNull();
    // No schedule created
    expect(insertedScheduleValues).toBeNull();
  });

  it('only includes explicitly provided active hours (no defaults injected)', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Custom schedule',
        workspaceId: 'ws-1',
        cronExpression: '0 */6 * * *',
        activeHoursStart: 10,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.cronExpression).toBe('0 */6 * * *');
    const ctx = insertedScheduleValues.taskTemplate.context;
    expect(ctx.heartbeat).toBe(true);
    expect(ctx.activeHoursStart).toBe(10);
    // No defaults injected for fields not provided
    expect(ctx.activeHoursEnd).toBeUndefined();
    expect(ctx.activeHoursTimezone).toBeUndefined();
  });

  it('rejects activeHoursStart outside 0-23', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bad Hours',
        activeHoursStart: 25,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('activeHoursStart');
  });

  it('rejects activeHoursEnd outside 0-23', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bad Hours',
        activeHoursEnd: -1,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('activeHoursEnd');
  });

  it('accepts activeHoursStart of 0 in schedule context', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Midnight Start',
        workspaceId: 'ws-1',
        cronExpression: '0 * * * *',
        activeHoursStart: 0,
        activeHoursEnd: 23,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const ctx = insertedScheduleValues.taskTemplate.context;
    expect(ctx.activeHoursStart).toBe(0);
    expect(ctx.activeHoursEnd).toBe(23);
  });

  it('should create a scheduled mission without workspaceId', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Workspace-less Mission',
        cronExpression: '0 * * * *',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scheduleId).toBeDefined();
    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.workspaceId).toBeNull();
  });

  it('should create a scheduled mission with workspaceId', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Workspace Mission',
        workspaceId: 'ws-1',
        cronExpression: '0 * * * *',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.workspaceId).toBe('ws-1');
  });

  // Auto-start organizer tests
  it('auto-starts the organizer after mission creation', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Auto-start Mission' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // runMission should have been called with the new mission ID
    expect(mockRunMission).toHaveBeenCalledWith('obj-1', { manualRun: true });

    // Response should include the organizerTask
    const body = await res.json();
    expect(body.organizerTask).toBeDefined();
    expect(body.organizerTask.id).toBe('organizer-task-1');
  });

  it('stores maxConcurrentTasks in mission insert', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Capped Mission', maxConcurrentTasks: 3 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues).not.toBeNull();
    expect(insertedMissionValues.maxConcurrentTasks).toBe(3);
  });

  it('stores maxConcurrentTasks as null when omitted', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Uncapped Mission' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues).not.toBeNull();
    expect(insertedMissionValues.maxConcurrentTasks).toBeNull();
  });

  it('rejects maxConcurrentTasks < 1', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Bad Cap', maxConcurrentTasks: 0 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxConcurrentTasks');
  });

  it('rejects a hand-written mergePolicy path with a 400 that points to Re-scan repo', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Legacy paths',
        mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'r', escalateToPaths: ['infra/'] } },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('mergePolicy.agentReview.escalateToPaths');
    expect(body.error).toContain('Re-scan repo');
  });

  it('rejects non-integer maxConcurrentTasks', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Bad Cap', maxConcurrentTasks: 2.5 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxConcurrentTasks');
  });

  it('rejects maxConcurrentTasks > 20', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Bad Cap', maxConcurrentTasks: 21 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxConcurrentTasks');
  });

  it('accepts maxConcurrentTasks = 20 (ceiling)', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Max Cap Mission', maxConcurrentTasks: 20 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it('does NOT auto-start when created with status=paused (paused-on-create regression)', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Paused Mission', status: 'paused' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // status must be stored in the INSERT
    expect(insertedMissionValues.status).toBe('paused');
    // runMission must NOT be called — no planning task can be enqueued
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('does NOT auto-start when isHeartbeat=false', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Inert Mission', isHeartbeat: false }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(mockRunMission).not.toHaveBeenCalled();
  });

  it('auto-starts when status=active explicitly set', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Active Mission', status: 'active' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(mockRunMission).toHaveBeenCalledWith('obj-1', { manualRun: true });
  });

  it('stores initiativeId when a valid initiative is provided', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: 'init-1', teamId: 'team-1' });
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Mission under initiative', initiativeId: 'init-1' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues.initiativeId).toBe('init-1');
  });

  it('rejects an initiativeId belonging to another team', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: 'init-x', teamId: 'team-other' });
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Bad initiative', initiativeId: 'init-x' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('initiative');
  });

  it('defaults initiativeId to null when omitted', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Ungrouped mission' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues.initiativeId).toBeNull();
  });

  it('defaults integrationBranchEnabled to true when workspace has no branchStrategy set (opt-out default)', async () => {
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-1', teamId: 'team-1', gitConfig: null });

    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Default strategy mission', workspaceId: 'ws-1' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues.integrationBranchEnabled).toBe(true);
  });

  it('sets integrationBranchEnabled to true when workspace explicitly resolves to mission-branch', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws-1',
      teamId: 'team-1',
      gitConfig: { branchStrategy: 'mission-branch' },
    });

    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Explicit mission-branch mission', workspaceId: 'ws-1' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues.integrationBranchEnabled).toBe(true);
  });

  it('sets integrationBranchEnabled to false when workspace resolves to direct', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws-1',
      teamId: 'team-1',
      gitConfig: { branchStrategy: 'direct' },
    });

    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Direct strategy mission', workspaceId: 'ws-1' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues.integrationBranchEnabled).toBe(false);
  });

  it('defaults integrationBranchEnabled to true for a workspace-less mission', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'No workspace mission' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues.integrationBranchEnabled).toBe(true);
  });

  it('rejects an invalid branchStrategy value', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Bad strategy mission', branchStrategy: 'trunk' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('branchStrategy');
    expect(mockMissionsInsert).not.toHaveBeenCalled();
  });

  it('an explicit branchStrategy overrides the workspace default', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws-1',
      teamId: 'team-1',
      gitConfig: { branchStrategy: 'direct' },
    });

    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Override mission', workspaceId: 'ws-1', branchStrategy: 'mission-branch' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues.integrationBranchEnabled).toBe(true);
  });

  it('mission-branch strategy generates the working branch and ensures it on the remote in the same request', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Ship the onboarding flow', workspaceId: 'ws-1', branchStrategy: 'mission-branch' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedMissionValues.integrationBranchEnabled).toBe(true);
    // The branch name is written back onto the mission row — never left flag-on-but-inert.
    expect(updatedMissionValues).not.toBeNull();
    // Mock mission id is 'obj-1' (returned by the insert mock's .returning()) — shorter than
    // 8 chars, so the id-slice is the whole string.
    expect(updatedMissionValues.workingBranch).toBe('mission/ship-the-onboarding-flow-obj-1');
    expect(mockEnsureMissionIntegrationBranch).toHaveBeenCalledWith('obj-1');

    const body = await res.json();
    expect(body.workingBranch).toBe(updatedMissionValues.workingBranch);
    // No inert-flag failure note when the ref was created successfully.
    expect(mockPostMissionFeedEvent).not.toHaveBeenCalled();
  });

  it('direct strategy generates no working branch and never calls ensure', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws-1',
      teamId: 'team-1',
      gitConfig: { branchStrategy: 'direct' },
    });

    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Direct mission', workspaceId: 'ws-1' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedMissionValues.integrationBranchEnabled).toBe(false);
    expect(updatedMissionValues).toBeNull();
    expect(mockEnsureMissionIntegrationBranch).not.toHaveBeenCalled();
    expect(mockPostMissionFeedEvent).not.toHaveBeenCalled();
  });

  it('a remote-ref failure still creates the mission with the flag and branch name, and posts a feed note — never a silent success', async () => {
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: false, reason: 'api_error', detail: 'GitHub API error: 500' } as any);

    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Flaky remote mission', workspaceId: 'ws-1', branchStrategy: 'mission-branch' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedMissionValues.integrationBranchEnabled).toBe(true);
    expect(updatedMissionValues).not.toBeNull();
    expect(updatedMissionValues.workingBranch).toMatch(/^mission\//);
    expect(mockPostMissionFeedEvent).toHaveBeenCalledTimes(1);
    const feedCall = mockPostMissionFeedEvent.mock.calls[0][0] as any;
    expect(feedCall.missionId).toBe('obj-1');
    expect(feedCall.body).toContain('api_error');
    // Actionable, and traced under the one stable signature.
    expect(feedCall.body).toContain('**To fix:**');
    expect(mockReportMissionBranchUnresolved).toHaveBeenCalledTimes(1);
    const trace = mockReportMissionBranchUnresolved.mock.calls[0][0] as any;
    expect(trace).toMatchObject({ missionId: 'obj-1', where: 'mission_create', cause: 'api_error', fallback: 'none' });
    expect(trace.branch).toBe(updatedMissionValues.workingBranch);
  });

  it('a workspace-less mission-branch mission defers the branch instead of reporting a no_repo dead end', async () => {
    // Regression (mission 6341fe61): no workspace → resolveBranchStrategy(null)
    // defaults to mission-branch, and the create-time ensure could only ever
    // answer no_repo. The branch is cut later, from the first task's workspace.
    mockReportMissionBranchUnresolved.mockClear();
    const res = await POST(new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Team level mission', branchStrategy: 'mission-branch' }),
    }));
    expect(res.status).toBe(201);
    expect(insertedMissionValues.integrationBranchEnabled).toBe(true);
    expect(updatedMissionValues.workingBranch).toMatch(/^mission\//);
    expect(mockEnsureMissionIntegrationBranch).not.toHaveBeenCalled();
    expect(mockPostMissionFeedEvent).not.toHaveBeenCalled();
    expect(mockReportMissionBranchUnresolved).not.toHaveBeenCalled();
  });

  it('still succeeds when auto-start organizer fails', async () => {
    mockRunMission.mockRejectedValue(new Error('dispatch failed'));

    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Resilient Mission' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    const body = await res.json();
    // Mission created, but organizerTask is null
    expect(body.title).toBe('Resilient Mission');
    expect(body.organizerTask).toBeNull();
  });
});

describe('GET /api/missions', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockMissionsFindMany.mockReset();

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindMany.mockResolvedValue([]);
  });

  it('includes lastDeferralReason and lastDeferredAt in response', async () => {
    const deferredAt = new Date('2026-04-17T10:00:00Z');
    mockMissionsFindMany.mockResolvedValue([
      {
        id: 'mission-1',
        title: 'Deferred mission',
        status: 'active',
        tasks: [],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        schedule: {
          cronExpression: '*/30 * * * *',
          nextRunAt: new Date('2026-04-17T11:00:00Z'),
          lastRunAt: new Date('2026-04-17T09:00:00Z'),
          lastDeferralReason: 'concurrent_cap',
          lastDeferredAt: deferredAt,
        },
      },
    ]);

    const req = new NextRequest('http://localhost/api/missions');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.missions).toHaveLength(1);
    expect(body.missions[0].lastDeferralReason).toBe('concurrent_cap');
    expect(body.missions[0].lastDeferredAt).toBeTruthy();
  });

  it('scopes to a single team when teamId is a team the user belongs to', async () => {
    mockResolveAccountTeamIds.mockResolvedValue(['team-1', 'team-2']);
    mockMissionsFindMany.mockResolvedValue([
      { id: 'm-1', title: 'A', status: 'active', tasks: [], schedule: null, createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);

    const req = new NextRequest('http://localhost/api/missions?teamId=team-2');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.missions).toHaveLength(1);
    // The query ran scoped to the requested team
    expect(mockMissionsFindMany).toHaveBeenCalled();
    const whereArg = mockMissionsFindMany.mock.calls[0][0].where;
    expect(whereArg.values).toEqual(['team-2']);
  });

  it('returns empty (no leak) when teamId is a team the user is NOT in', async () => {
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);

    const req = new NextRequest('http://localhost/api/missions?teamId=team-other');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.missions).toEqual([]);
    // Must not have queried with the foreign team
    expect(mockMissionsFindMany).not.toHaveBeenCalled();
  });

  it('status=open lists every mission not completed or archived, and limit caps the query', async () => {
    await GET(new NextRequest('http://localhost/api/missions?status=open&limit=15'));
    const args = mockMissionsFindMany.mock.calls[0][0];
    // drizzle-orm is mocked in this file: `and` returns its predicates as an array.
    expect(args.where).toContainEqual({ field: undefined, values: ['completed', 'archived'], type: 'notInArray' });
    expect(args.limit).toBe(15);
  });

  it('no status and no limit: every mission, unbounded, as before (the dashboard relies on it)', async () => {
    await GET(new NextRequest('http://localhost/api/missions'));
    const args = mockMissionsFindMany.mock.calls[0][0];
    expect(args.limit).toBeUndefined();
    expect(args.where.type).toBe('inArray');
  });

  it('q filters by title substring, ranks the exact title first, then sort=recent orders by latest activity', async () => {
    await GET(new NextRequest('http://localhost/api/missions?q=Memory&sort=recent&limit=5'));
    const args = mockMissionsFindMany.mock.calls[0][0];
    expect(args.where).toContainEqual({ field: undefined, value: '%Memory%', type: 'ilike' });
    expect(args.orderBy[0].field.type).toBe('sql');
    expect(args.orderBy[0].field.strings[0]).toBe('lower(');
    expect(args.orderBy[1].field.strings[0]).toBe('coalesce(greatest(');
  });

  it('sort=recent without q has no exact-title ranking', async () => {
    await GET(new NextRequest('http://localhost/api/missions?sort=recent'));
    const args = mockMissionsFindMany.mock.calls[0][0];
    expect(args.orderBy[0].field.strings[0]).toBe('coalesce(greatest(');
  });

  it('default order is still priority first (the dashboard relies on it)', async () => {
    await GET(new NextRequest('http://localhost/api/missions'));
    const args = mockMissionsFindMany.mock.calls[0][0];
    expect(args.orderBy[0]).toEqual({ field: undefined, type: 'desc' });
    expect(args.orderBy[0].field?.type).not.toBe('sql');
  });

  it('a capped list reports total so callers can say "showing N of M"', async () => {
    mockMissionsCount.mockReset();
    mockMissionsCount.mockResolvedValue(42);
    mockMissionsFindMany.mockResolvedValue([
      { id: 'm-1', title: 'A', status: 'active', tasks: [], schedule: null, createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);
    const res = await GET(new NextRequest('http://localhost/api/missions?limit=1'));
    const body = await res.json();
    expect(body.total).toBe(42);
    // Counted over the same predicate as the page.
    const [, countWhere] = mockMissionsCount.mock.calls[0] as any[];
    expect(countWhere).toEqual(mockMissionsFindMany.mock.calls[0][0].where);
  });

  it('an uncapped list skips the count query', async () => {
    mockMissionsCount.mockReset();
    const res = await GET(new NextRequest('http://localhost/api/missions'));
    const body = await res.json();
    expect(mockMissionsCount).not.toHaveBeenCalled();
    expect(body.total).toBe(0);
  });

  it('returns null deferral fields when schedule has no deferral', async () => {
    mockMissionsFindMany.mockResolvedValue([
      {
        id: 'mission-2',
        title: 'Normal mission',
        status: 'active',
        tasks: [],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        schedule: {
          cronExpression: '*/30 * * * *',
          nextRunAt: new Date(),
          lastRunAt: new Date(),
          lastDeferralReason: null,
          lastDeferredAt: null,
        },
      },
    ]);

    const req = new NextRequest('http://localhost/api/missions');
    const res = await GET(req);
    const body = await res.json();

    expect(body.missions[0].lastDeferralReason).toBeNull();
    expect(body.missions[0].lastDeferredAt).toBeNull();
  });
});

describe('POST /api/missions — goalCriteria validation', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockMissionsInsert.mockReset();
    mockSchedulesInsert.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockInitiativesFindFirst.mockReset();
    mockRunMission.mockReset();
    mockEnsureMissionIntegrationBranch.mockReset();
    mockResolveFeedActor.mockReset();
    mockPostMissionFeedEvent.mockReset();
    insertedMissionValues = null;
    updatedMissionValues = null;
    scheduleLinkValues = null;

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-1', teamId: 'team-1' });
    mockInitiativesFindFirst.mockResolvedValue(null);
    mockRunMission.mockResolvedValue({ task: { id: 'organizer-task-1' } });
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: 'mission/x-00000000', created: true } as any);
    mockResolveFeedActor.mockResolvedValue({ kind: 'system', id: null, label: 'system' } as any);
    mockPostMissionFeedEvent.mockResolvedValue(undefined as any);
    mockMissionsInsert.mockImplementation(() => ({
      values: mock((vals: any) => {
        insertedMissionValues = vals;
        return { returning: mock(() => [{ id: 'obj-1', ...vals }]) };
      }),
    }));
    mockSchedulesInsert.mockImplementation(() => ({
      values: mock((vals: any) => ({
        returning: mock(() => [{ id: 'sched-1', ...vals }]),
      })),
    }));
  });

  it('rejects goalCriteria item without type field', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Mission with bad criteria',
        goalCriteria: [{ description: 'All PRs merged' }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/goalCriteria\[0\]/);
  });

  it('rejects goalCriteria item with invalid type', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Mission with bad criteria',
        goalCriteria: [{ type: 'unknown_type', label: 'Something' }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/goalCriteria\[0\]/);
  });

  it('accepts goalCriteria with valid types', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Mission with good criteria',
        goalCriteria: [
          { type: 'all_prs_merged' },
          { type: 'command', command: 'bun run test' },
          { type: 'no_open_tasks' },
        ],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it('rejects a prose criterion that does not say why it cannot be mechanized', async () => {
    // A description criterion's verdict needs a live model, so it is the one
    // form that can silently degrade to NOT_EVALUATED. Writing one is allowed,
    // but only deliberately.
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Mission with prose criteria',
        goalCriteria: [{ type: 'description', description: 'All tasks reviewed', label: 'Reviewed' }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/notMechanizableReason/);
    expect(body.error).toMatch(/command/);
  });

  it('accepts a prose criterion that states its reason, paired with a mechanical one', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Mission with justified prose criteria',
        goalCriteria: [
          {
            type: 'description',
            description: 'The error copy reads as helpful rather than accusatory',
            notMechanizableReason: 'Tone is a human judgement; no command can assert it.',
          },
          { type: 'no_open_tasks' },
        ],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it('passes an omitted goalCriteria through unchanged', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Mission with no stated goal' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it('rejects goalCriteria with no mechanical criterion, naming the accepted types', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Mission with prose-only criteria',
        goalCriteria: [{
          type: 'description',
          description: 'The error copy reads as helpful rather than accusatory',
          notMechanizableReason: 'Tone is a human judgement; no command can assert it.',
        }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mechanical criterion/);
    expect(body.error).not.toContain('all_prs_merged + no_open_tasks');
    expect(body.error).toContain('command');
    expect(body.error).toContain('artifact_exists');
  });

  it('rejects a command criterion with no command (previously accepted, then unevaluatable)', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Mission with empty command criterion',
        goalCriteria: [{ type: 'command', label: 'tests pass' }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/command is required/);
  });

  it('rejects non-object criterion (e.g. string)', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Mission with string criteria',
        goalCriteria: ['All PRs merged'],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/goalCriteria\[0\]/);
  });
  describe('goal-criteria quality shadow (docs/specs/mission-goal-criteria-quality.md)', () => {
    const allowed = async () => ({ ok: true, apiKey: 'k', model: 'jev-test' });
    const disabled = async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'mission_goal_quality' } });
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
    const create = (criteria: unknown[]) => POST(new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Goal quality', orchestrationMode: 'manual', goalCriteria: criteria }),
    }));
    const quality = () => recordedGateEvents.filter(e => e.gate === 'goal_criteria_quality');

    beforeEach(() => {
      recordedGateEvents.length = 0;
      goalQualityDecideCalls.length = 0;
      goalQualityAccess = disabled;
      goalQualityDecide = grading;
    });

    it('capability off: 201, no decision call, no goal_criteria_quality row (AC-1)', async () => {
      const res = await create([{ type: 'command', command: 'bun run test', label: 'off: tests pass' }]);
      expect(res.status).toBe(201);
      await flush();
      expect(goalQualityDecideCalls).toHaveLength(0);
      expect(quality()).toEqual([]);
    });

    it('shadow: the response body is identical to capability off, and the stored goal is the submitted one (AC-3, AC-4, AC-12)', async () => {
      const criteria = [{ type: 'command', command: 'bun run test', label: 'same body: tests pass' }, { type: 'all_prs_merged' }];
      const off = await (await create(criteria)).json();
      await flush();
      goalQualityAccess = allowed;
      const res = await create(criteria);
      expect(res.status).toBe(201);
      const on = await res.json();
      expect(on).toEqual(off);
      expect(on).not.toHaveProperty('advisory');
      expect(insertedMissionValues.goalCriteria).toEqual(criteria);
      await flush();
      expect(goalQualityDecideCalls).toHaveLength(1);
    });

    it('a weak criterion records one warned row, without its text (AC-7)', async () => {
      goalQualityAccess = allowed;
      await create([
        { type: 'command', command: 'bun run e2e signup', label: 'warned: a visitor can sign up' },
        { type: 'command', command: 'bun run test', label: 'warned: tests pass' },
      ]);
      await flush();
      const rows = quality();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: 'warned', surface: 'POST /api/missions', missionId: 'obj-1', detail: { index: 1, type: 'command' } });
      expect(JSON.stringify(rows[0])).not.toContain('tests pass');
      expect(JSON.stringify(rows[0])).not.toContain('bun run test');
    });

    it('a strong criterion records no warned row', async () => {
      goalQualityAccess = allowed;
      await create([{ type: 'command', command: 'bun run e2e signup', label: 'strong: a visitor can sign up' }]);
      await flush();
      expect(goalQualityDecideCalls).toHaveLength(1);
      expect(quality()).toEqual([]);
    });

    it('the decision call never sends the command string (AC-6)', async () => {
      goalQualityAccess = allowed;
      await create([{ type: 'command', command: 'bun run scripts/secret-check.ts', label: 'sent: a visitor can sign up' }]);
      await flush();
      expect(JSON.stringify(goalQualityDecideCalls[0].state)).not.toContain('secret-check');
    });

    it('a never-resolving decision call cannot delay the response (AC-2)', async () => {
      goalQualityAccess = allowed;
      goalQualityDecide = () => new Promise(() => {});
      const res = await create([{ type: 'command', command: 'bun run test', label: 'hang: tests pass' }]);
      expect(res.status).toBe(201);
      expect(await res.json()).not.toHaveProperty('advisory');
    });

    it('a throwing decision call cannot fail the response (AC-2)', async () => {
      goalQualityAccess = allowed;
      goalQualityDecide = async () => { throw new Error('provider down'); };
      const res = await create([{ type: 'command', command: 'bun run test', label: 'throw: tests pass' }]);
      expect(res.status).toBe(201);
      await flush();
      expect(quality()).toEqual([]);
    });

    it('a 400 from validation makes no decision call', async () => {
      goalQualityAccess = allowed;
      const res = await create([{ type: 'description', description: 'feels nice', notMechanizableReason: 'it is a feeling, nothing to run' }]);
      expect(res.status).toBe(400);
      await flush();
      expect(goalQualityDecideCalls).toHaveLength(0);
    });
  });
});

// Evaluates the mocked drizzle predicates against fixture rows (`and` is a
// bare array in this file's drizzle mock), so the scope the resolver asks the
// db for is what decides the outcome.
function matches(p: any, row: Record<string, unknown>): boolean {
  if (p === undefined || p === null) return true;
  if (Array.isArray(p)) return p.every((a) => matches(a, row));
  if (p.type === 'eq') return row[p.field] === p.value;
  if (p.type === 'inArray') return p.values.includes(row[p.field]);
  if (p.type === 'or') return p.args.some((a: any) => matches(a, row));
  throw new Error(`unhandled predicate ${p.type}`);
}

describe('POST /api/missions — workspace reach (shared rule)', () => {
  const WS_OWN_OPEN = '10000000-0000-4000-8000-000000000001';
  const WS_LINKED = '10000000-0000-4000-8000-000000000002';
  const WS_FOREIGN_OPEN = '10000000-0000-4000-8000-000000000003';
  const WS_MISSING = '10000000-0000-4000-8000-000000000009';
  const FIXTURE = [
    { id: WS_OWN_OPEN, teamId: 'team-a', accessMode: 'open', gitConfig: null },
    { id: WS_LINKED, teamId: 'team-b', accessMode: 'restricted', gitConfig: null },
    { id: WS_FOREIGN_OPEN, teamId: 'team-b', accessMode: 'open', gitConfig: null },
  ];
  const LINKS = [{ accountId: 'acct-a', workspaceId: WS_LINKED, canClaim: true, canCreate: true }];

  beforeEach(() => {
    insertedMissionValues = null;
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockReturnValue({ id: 'acct-a', name: 'runner', level: 'admin', teamId: 'team-a' } as any);
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockImplementation((async (opts: any) => FIXTURE.find((r) => matches(opts?.where, r))) as any);
    mockAccountWorkspacesFindMany.mockReset();
    mockAccountWorkspacesFindMany.mockImplementation((async (opts: any) => LINKS.filter((r) => matches(opts?.where, r))) as any);
    mockAccountWorkspacesFindFirst.mockReset();
    mockAccountWorkspacesFindFirst.mockImplementation((async (opts: any) => LINKS.find((r) => matches(opts?.where, r))) as any);
    mockRunMission.mockResolvedValue({ task: { id: 'organizer-task-1' } });
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: 'mission/x-00000000', created: true } as any);
    mockResolveFeedActor.mockResolvedValue({ kind: 'system', id: null, label: 'system' } as any);
    mockMissionsInsert.mockImplementation(() => ({
      values: mock((vals: any) => {
        insertedMissionValues = vals;
        return { returning: mock(() => [{ id: 'obj-1', ...vals }]) };
      }),
    }));
    mockSchedulesInsert.mockImplementation(() => ({
      values: mock((vals: any) => ({ returning: mock(() => [{ id: 'sched-1', ...vals }]) })),
    }));
  });

  const create = (workspaceId: string) => POST(new NextRequest('http://localhost/api/missions', {
    method: 'POST',
    headers: { authorization: 'Bearer bld_test' },
    body: JSON.stringify({ title: 'Reach', workspaceId }),
  }));

  it("accepts the account's own team's open workspace", async () => {
    const res = await create(WS_OWN_OPEN);
    expect(res.status).toBe(201);
    expect(insertedMissionValues.workspaceId).toBe(WS_OWN_OPEN);
    expect(insertedMissionValues.teamId).toBe('team-a');
  });

  it('accepts a workspace the account is explicitly linked to (canCreate), in another team', async () => {
    const res = await create(WS_LINKED);
    expect(res.status).toBe(201);
    expect(insertedMissionValues.workspaceId).toBe(WS_LINKED);
    expect(insertedMissionValues.teamId).toBe('team-b');
  });

  it("refuses another team's open workspace with 403 \"No access to workspace\"", async () => {
    const res = await create(WS_FOREIGN_OPEN);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('No access to workspace');
    expect(insertedMissionValues).toBeNull();
  });

  it('answers 404 "No workspace found" when nothing by that id exists', async () => {
    const res = await create(WS_MISSING);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('No workspace found');
    expect(insertedMissionValues).toBeNull();
  });
});
