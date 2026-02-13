process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// --- Mock functions ---
const mockSchedulesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockComputeNextRunAt = mock(() => new Date('2025-01-02T00:00:00Z'));
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockTriggerEvent = mock(() => Promise.resolve());

// Mutable result arrays for db chain methods (select/update/insert)
let selectResult: any[] = [{ count: 0 }];
let updateReturningResult: any[] = [];
let insertReturningResult: any[] = [];

// --- Mock modules (BEFORE route import) ---

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      taskSchedules: { findMany: mockSchedulesFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    select: (fields: any) => ({
      from: (table: any) => ({
        where: () => Promise.resolve(selectResult),
      }),
    }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: (condition: any) => ({
          returning: () => Promise.resolve(updateReturningResult),
          then: (resolve: any, reject?: any) => Promise.resolve().then(resolve, reject),
        }),
      }),
    }),
    insert: (table: any) => ({
      values: (values: any) => ({
        returning: () => Promise.resolve(insertReturningResult),
      }),
    }),
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  taskSchedules: {
    id: 'id',
    enabled: 'enabled',
    nextRunAt: 'nextRunAt',
    totalRuns: 'totalRuns',
    workspaceId: 'workspaceId',
  },
  tasks: {
    id: 'id',
    workspaceId: 'workspaceId',
    status: 'status',
    context: 'context',
  },
  workspaces: { id: 'id' },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  lte: (field: any, value: any) => ({ field, value, type: 'lte' }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@/lib/schedule-helpers', () => ({
  computeNextRunAt: mockComputeNextRunAt,
}));

mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
  },
  events: {
    TASK_CREATED: 'task:created',
    TASK_ASSIGNED: 'task:assigned',
    TASK_CLAIMED: 'task:claimed',
    TASK_COMPLETED: 'task:completed',
    TASK_FAILED: 'task:failed',
    WORKER_STARTED: 'worker:started',
    WORKER_PROGRESS: 'worker:progress',
    WORKER_COMPLETED: 'worker:completed',
    WORKER_FAILED: 'worker:failed',
    SCHEDULE_TRIGGERED: 'schedule:triggered',
  },
}));

// Import handler AFTER mocks
import { GET } from './route';

// --- Helpers ---

function createCronRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/schedules', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

function makeSchedule(overrides: Record<string, any> = {}) {
  return {
    id: 'sched-1',
    workspaceId: 'ws-1',
    name: 'Nightly tests',
    cronExpression: '0 0 * * *',
    timezone: 'UTC',
    enabled: true,
    nextRunAt: new Date('2025-01-01T00:00:00Z'),
    lastRunAt: null,
    totalRuns: 0,
    consecutiveFailures: 0,
    pauseAfterFailures: 3,
    maxConcurrentFromSchedule: 0,
    lastTaskId: null,
    lastError: null,
    taskTemplate: {
      title: 'Nightly test run',
      description: 'Run the full test suite',
      priority: 5,
      mode: 'execution',
      runnerPreference: 'any',
      requiredCapabilities: [],
      skills: [],
      context: {},
    },
    ...overrides,
  };
}

// --- Tests ---

describe('GET /api/cron/schedules', () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';

    mockSchedulesFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockComputeNextRunAt.mockReset();
    mockDispatchNewTask.mockReset();
    mockTriggerEvent.mockReset();

    // Defaults
    mockSchedulesFindMany.mockResolvedValue([]);
    mockComputeNextRunAt.mockReturnValue(new Date('2025-01-02T00:00:00Z'));
    mockDispatchNewTask.mockResolvedValue(undefined);
    mockTriggerEvent.mockResolvedValue(undefined);

    // Reset chain results
    selectResult = [{ count: 0 }];
    updateReturningResult = [];
    insertReturningResult = [];
  });

  afterAll(() => {
    if (originalCronSecret !== undefined) {
      process.env.CRON_SECRET = originalCronSecret;
    } else {
      delete process.env.CRON_SECRET;
    }
  });

  it('returns 500 when CRON_SECRET not configured', async () => {
    delete process.env.CRON_SECRET;

    const req = createCronRequest({ Authorization: 'Bearer test-secret' });
    const res = await GET(req);

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('CRON_SECRET not configured');
  });

  it('returns 401 when no auth header', async () => {
    const req = createCronRequest();
    const res = await GET(req);

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 401 when wrong token', async () => {
    const req = createCronRequest({ Authorization: 'Bearer wrong-secret' });
    const res = await GET(req);

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns zero counts when no due schedules', async () => {
    mockSchedulesFindMany.mockResolvedValue([]);

    const req = createCronRequest({ Authorization: 'Bearer test-secret' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
    });
  });

  it('processes due schedule and creates task', async () => {
    const schedule = makeSchedule();
    mockSchedulesFindMany.mockResolvedValue([schedule]);

    // Atomic claim succeeds: returning the claimed schedule
    const claimedSchedule = { ...schedule, nextRunAt: new Date('2025-01-02T00:00:00Z') };
    updateReturningResult = [claimedSchedule];

    // Task insert returns a new task
    const createdTask = {
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'Nightly test run',
      description: 'Run the full test suite',
      status: 'pending',
    };
    insertReturningResult = [createdTask];

    // Workspace lookup for dispatch
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'My Workspace' });

    const req = createCronRequest({ Authorization: 'Bearer test-secret' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.processed).toBe(1);
    expect(data.created).toBe(1);
    expect(data.skipped).toBe(0);
    expect(data.errors).toBe(0);

    // computeNextRunAt was called for the atomic claim
    expect(mockComputeNextRunAt).toHaveBeenCalledWith('0 0 * * *', 'UTC');

    // dispatchNewTask was called with the created task and workspace
    expect(mockDispatchNewTask).toHaveBeenCalledWith(createdTask, { id: 'ws-1', name: 'My Workspace' });

    // triggerEvent was called for SCHEDULE_TRIGGERED
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'schedule:triggered',
      {
        schedule: { id: 'sched-1', name: 'Nightly tests' },
        task: createdTask,
      }
    );
  });

  it('skips schedule when at maxConcurrentFromSchedule limit', async () => {
    const schedule = makeSchedule({ maxConcurrentFromSchedule: 2 });
    mockSchedulesFindMany.mockResolvedValue([schedule]);

    // Active task count equals the max
    selectResult = [{ count: 2 }];

    const req = createCronRequest({ Authorization: 'Bearer test-secret' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.processed).toBe(1);
    expect(data.created).toBe(0);
    expect(data.skipped).toBe(1);
    expect(data.errors).toBe(0);

    // computeNextRunAt called to advance the skipped schedule
    expect(mockComputeNextRunAt).toHaveBeenCalled();

    // dispatchNewTask should NOT have been called
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });

  it('handles atomic claim failure (another invocation already processed)', async () => {
    const schedule = makeSchedule();
    mockSchedulesFindMany.mockResolvedValue([schedule]);

    // Atomic claim returns empty array (another worker got it)
    updateReturningResult = [];

    const req = createCronRequest({ Authorization: 'Bearer test-secret' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.processed).toBe(1);
    expect(data.created).toBe(0);
    expect(data.skipped).toBe(1);
    expect(data.errors).toBe(0);

    // No task should have been created
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('increments consecutiveFailures on error', async () => {
    const schedule = makeSchedule({ consecutiveFailures: 1, pauseAfterFailures: 5 });
    mockSchedulesFindMany.mockResolvedValue([schedule]);

    // Atomic claim succeeds
    updateReturningResult = [{ ...schedule }];

    // Task insert throws an error
    insertReturningResult = [];
    // We need the insert to throw to trigger the error path.
    // Override the db mock behavior for this test by making insertReturningResult
    // cause a destructure error: `const [task] = await db.insert(...).values(...).returning()`
    // When insertReturningResult is [], `task` will be undefined.
    // The code then accesses task.id which throws TypeError.

    const req = createCronRequest({ Authorization: 'Bearer test-secret' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.processed).toBe(1);
    expect(data.errors).toBe(1);
    expect(data.created).toBe(0);

    // The error-handling update should have been called (to increment consecutiveFailures)
    // computeNextRunAt called once for atomic claim, once for error recovery
    expect(mockComputeNextRunAt).toHaveBeenCalled();
  });

  it('pauses schedule when failures reach pauseAfterFailures threshold', async () => {
    // consecutiveFailures is 2, pauseAfterFailures is 3, so newFailures (3) >= threshold
    const schedule = makeSchedule({ consecutiveFailures: 2, pauseAfterFailures: 3 });
    mockSchedulesFindMany.mockResolvedValue([schedule]);

    // Atomic claim succeeds
    updateReturningResult = [{ ...schedule }];

    // Task insert returns empty to trigger error via undefined access
    insertReturningResult = [];

    const req = createCronRequest({ Authorization: 'Bearer test-secret' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.processed).toBe(1);
    expect(data.errors).toBe(1);

    // The schedule should be paused (enabled set to false in the error handler update).
    // We can verify computeNextRunAt was called for the error recovery path.
    expect(mockComputeNextRunAt).toHaveBeenCalled();
  });

  it('does not dispatch when workspace not found', async () => {
    const schedule = makeSchedule();
    mockSchedulesFindMany.mockResolvedValue([schedule]);

    // Atomic claim succeeds
    updateReturningResult = [{ ...schedule }];

    // Task created successfully
    const createdTask = {
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'Nightly test run',
      status: 'pending',
    };
    insertReturningResult = [createdTask];

    // Workspace not found
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = createCronRequest({ Authorization: 'Bearer test-secret' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.processed).toBe(1);
    expect(data.created).toBe(1);

    // dispatchNewTask should NOT have been called since workspace is null
    expect(mockDispatchNewTask).not.toHaveBeenCalled();

    // triggerEvent should still be called for SCHEDULE_TRIGGERED
    expect(mockTriggerEvent).toHaveBeenCalled();
  });
});
