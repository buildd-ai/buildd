// Ensure test mode — routes short-circuit in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockTaskSchedulesFindFirst = mock(() => null as any);
const mockUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => []),
    })),
  })),
}));
const mockDelete = mock(() => ({
  where: mock(() => ({
    returning: mock(() => []),
  })),
}));
const mockValidateCronExpression = mock(() => null as string | null);
const mockComputeNextRunAt = mock(() => new Date('2026-01-01T00:00:00Z') as Date | null);

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock schedule-helpers
mock.module('@/lib/schedule-helpers', () => ({
  validateCronExpression: mockValidateCronExpression,
  computeNextRunAt: mockComputeNextRunAt,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      taskSchedules: { findFirst: mockTaskSchedulesFindFirst },
    },
    update: mockUpdate,
    delete: mockDelete,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  desc: (field: any) => ({ field, type: 'desc' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', ownerId: 'ownerId' },
  taskSchedules: { id: 'id', workspaceId: 'workspaceId' },
}));

// Import handlers AFTER mocks
import { GET, PATCH, DELETE } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body } = options;

  const url = 'http://localhost:3000/api/workspaces/ws-1/schedules/sched-1';
  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };

  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }

  return new NextRequest(url, init);
}

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

// ─── GET /api/workspaces/[id]/schedules/[scheduleId] ─────────────────────────

describe('GET /api/workspaces/[id]/schedules/[scheduleId]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockTaskSchedulesFindFirst.mockReset();
    process.env.NODE_ENV = 'test';
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const request = createMockRequest();
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-1' });
    const response = await GET(request, { params: mockParams });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const mockParams = Promise.resolve({ id: 'ws-nonexistent', scheduleId: 'sched-1' });
    const response = await GET(request, { params: mockParams });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns 404 when schedule not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockTaskSchedulesFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-nonexistent' });
    const response = await GET(request, { params: mockParams });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Schedule not found');
  });

  it('returns schedule successfully', async () => {
    const mockSchedule = {
      id: 'sched-1',
      name: 'Daily build',
      cronExpression: '0 9 * * *',
      workspaceId: 'ws-1',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockTaskSchedulesFindFirst.mockResolvedValue(mockSchedule);

    const request = createMockRequest();
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-1' });
    const response = await GET(request, { params: mockParams });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.schedule.id).toBe('sched-1');
    expect(data.schedule.name).toBe('Daily build');
  });
});

// ─── PATCH /api/workspaces/[id]/schedules/[scheduleId] ───────────────────────

describe('PATCH /api/workspaces/[id]/schedules/[scheduleId]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockTaskSchedulesFindFirst.mockReset();
    mockUpdate.mockReset();
    mockValidateCronExpression.mockReset();
    mockComputeNextRunAt.mockReset();
    process.env.NODE_ENV = 'test';

    // Default: valid cron
    mockValidateCronExpression.mockReturnValue(null);
    mockComputeNextRunAt.mockReturnValue(new Date('2026-01-01T00:00:00Z'));
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated' },
    });
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-1' });
    const response = await PATCH(request, { params: mockParams });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated' },
    });
    const mockParams = Promise.resolve({ id: 'ws-nonexistent', scheduleId: 'sched-1' });
    const response = await PATCH(request, { params: mockParams });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns 404 when schedule not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockTaskSchedulesFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated' },
    });
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-nonexistent' });
    const response = await PATCH(request, { params: mockParams });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Schedule not found');
  });

  it('returns 400 for invalid cron expression', async () => {
    const existingSchedule = {
      id: 'sched-1',
      name: 'Daily build',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      workspaceId: 'ws-1',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockTaskSchedulesFindFirst.mockResolvedValue(existingSchedule);
    mockValidateCronExpression.mockReturnValue('Invalid syntax');

    const request = createMockRequest({
      method: 'PATCH',
      body: { cronExpression: 'bad-cron' },
    });
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-1' });
    const response = await PATCH(request, { params: mockParams });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Invalid cron expression');
  });

  it('updates schedule fields successfully', async () => {
    const existingSchedule = {
      id: 'sched-1',
      name: 'Daily build',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      workspaceId: 'ws-1',
    };

    const updatedSchedule = {
      ...existingSchedule,
      name: 'Updated name',
      maxConcurrentFromSchedule: 3,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockTaskSchedulesFindFirst.mockResolvedValue(existingSchedule);

    const mockReturning = mock(() => [updatedSchedule]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated name', maxConcurrentFromSchedule: 3 },
    });
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-1' });
    const response = await PATCH(request, { params: mockParams });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.schedule.name).toBe('Updated name');
    expect(data.schedule.maxConcurrentFromSchedule).toBe(3);
  });

  it('recomputes nextRunAt when cronExpression changes', async () => {
    const existingSchedule = {
      id: 'sched-1',
      name: 'Daily build',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      workspaceId: 'ws-1',
    };

    const updatedSchedule = {
      ...existingSchedule,
      cronExpression: '0 12 * * *',
      nextRunAt: new Date('2026-01-01T12:00:00Z'),
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockTaskSchedulesFindFirst.mockResolvedValue(existingSchedule);
    mockValidateCronExpression.mockReturnValue(null);
    mockComputeNextRunAt.mockReturnValue(new Date('2026-01-01T12:00:00Z'));

    let capturedSetData: any = null;
    const mockReturning = mock(() => [updatedSchedule]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { cronExpression: '0 12 * * *' },
    });
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-1' });
    const response = await PATCH(request, { params: mockParams });

    expect(response.status).toBe(200);
    expect(mockComputeNextRunAt).toHaveBeenCalled();
    expect(capturedSetData.nextRunAt).toEqual(new Date('2026-01-01T12:00:00Z'));
    expect(capturedSetData.cronExpression).toBe('0 12 * * *');
  });

  it('sets nextRunAt to null when disabling schedule', async () => {
    const existingSchedule = {
      id: 'sched-1',
      name: 'Daily build',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      workspaceId: 'ws-1',
    };

    const updatedSchedule = {
      ...existingSchedule,
      enabled: false,
      nextRunAt: null,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockTaskSchedulesFindFirst.mockResolvedValue(existingSchedule);

    let capturedSetData: any = null;
    const mockReturning = mock(() => [updatedSchedule]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { enabled: false },
    });
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-1' });
    const response = await PATCH(request, { params: mockParams });

    expect(response.status).toBe(200);
    expect(capturedSetData.enabled).toBe(false);
    expect(capturedSetData.nextRunAt).toBeNull();
  });
});

// ─── DELETE /api/workspaces/[id]/schedules/[scheduleId] ──────────────────────

describe('DELETE /api/workspaces/[id]/schedules/[scheduleId]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockDelete.mockReset();
    process.env.NODE_ENV = 'test';
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const request = createMockRequest({ method: 'DELETE' });
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-1' });
    const response = await DELETE(request, { params: mockParams });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const request = createMockRequest({ method: 'DELETE' });
    const mockParams = Promise.resolve({ id: 'ws-nonexistent', scheduleId: 'sched-1' });
    const response = await DELETE(request, { params: mockParams });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns 404 when schedule not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockReturning = mock(() => []);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    mockDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({ method: 'DELETE' });
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-nonexistent' });
    const response = await DELETE(request, { params: mockParams });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Schedule not found');
  });

  it('deletes schedule successfully', async () => {
    const deletedSchedule = {
      id: 'sched-1',
      name: 'Daily build',
      workspaceId: 'ws-1',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockReturning = mock(() => [deletedSchedule]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    mockDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({ method: 'DELETE' });
    const mockParams = Promise.resolve({ id: 'ws-1', scheduleId: 'sched-1' });
    const response = await DELETE(request, { params: mockParams });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });
});
