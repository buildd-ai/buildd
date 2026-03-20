import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// --- Mock setup ---

// Set CRON_SECRET before importing the route
process.env.CRON_SECRET = 'test-secret';

const mockTaskSchedulesFindMany = mock(() => [] as any[]);
const mockMissionsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => ({ id: 'ws-1', name: 'Test Workspace' }) as any);
const mockWorkerHeartbeatsFindMany = mock(() => [] as any[]);

let taskSchedulesUpdateCalls: any[] = [];
let tasksInsertValues: any = null;

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

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      taskSchedules: { findMany: mockTaskSchedulesFindMany },
      missions: { findFirst: mockMissionsFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      workers: { findMany: mock(() => []) },
      workerHeartbeats: { findMany: mockWorkerHeartbeatsFindMany },
    },
    insert: mock((_table: any) => ({
      values: mock((vals: any) => {
        tasksInsertValues = vals;
        return {
          returning: mock(() => [{ id: 'task-1', ...vals }]),
        };
      }),
    })),
    update: mock((_table: any) => makeUpdateChain(taskSchedulesUpdateCalls)),
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => [{ count: 0 }]),
      })),
    })),
    delete: mock((_table: any) => ({
      where: mock(() => Promise.resolve()),
    })),
  },
}));

mock.module('drizzle-orm', () => ({
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
  taskSchedules: 'taskSchedules',
  tasks: 'tasks',
  workspaces: 'workspaces',
  missions: 'missions',
  workers: 'workers',
  workerHeartbeats: 'workerHeartbeats',
}));

mock.module('@/lib/schedule-helpers', () => ({
  computeNextRunAt: () => new Date('2026-01-01'),
  computeStaggerOffset: () => 0,
}));

mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mock(() => Promise.resolve()),
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { SCHEDULE_TRIGGERED: 'schedule-triggered' },
}));

mock.module('@/lib/mission-context', () => ({
  buildMissionContext: mock(() => Promise.resolve(null)),
  isWithinActiveHours: mock(() => true),
}));

const mockGetOrCreateCoordinationWorkspace = mock(() => Promise.resolve({ id: 'orchestrator-ws' }));
mock.module('@/lib/orchestrator-workspace', () => ({
  getOrCreateCoordinationWorkspace: mockGetOrCreateCoordinationWorkspace,
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
    mockTasksFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkerHeartbeatsFindMany.mockReset();
    mockGetOrCreateCoordinationWorkspace.mockReset();
    mockGetOrCreateCoordinationWorkspace.mockResolvedValue({ id: 'orchestrator-ws' });
    taskSchedulesUpdateCalls = [];
    tasksInsertValues = null;

    mockTaskSchedulesFindMany.mockResolvedValue([]);
    mockMissionsFindFirst.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'Test Workspace' });
    mockWorkerHeartbeatsFindMany.mockResolvedValue([]);
  });

  it('should resolve workspace from mission when schedule.workspaceId is null', async () => {
    const schedule = makeSchedule({ workspaceId: null });
    mockTaskSchedulesFindMany.mockResolvedValue([schedule]);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', workspaceId: 'ws-from-mission' });
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
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', workspaceId: null, teamId: 'team-1' });
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
});
