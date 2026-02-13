// Ensure test mode — routes short-circuit in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockTaskSchedulesFindMany = mock(() => [] as any[]);
const mockInsert = mock(() => ({
  values: mock(() => ({
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
      taskSchedules: { findMany: mockTaskSchedulesFindMany },
    },
    insert: mockInsert,
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
  taskSchedules: { id: 'id', workspaceId: 'workspaceId', createdAt: 'createdAt' },
}));

// Import handlers AFTER mocks
import { GET, POST } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body } = options;

  const url = 'http://localhost:3000/api/workspaces/ws-1/schedules';
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

describe('GET /api/workspaces/[id]/schedules', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockTaskSchedulesFindMany.mockReset();
    process.env.NODE_ENV = 'test';
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const request = createMockRequest();
    const mockParams = Promise.resolve({ id: 'ws-1' });
    const response = await GET(request, { params: mockParams });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const mockParams = Promise.resolve({ id: 'ws-nonexistent' });
    const response = await GET(request, { params: mockParams });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns schedules list for valid workspace', async () => {
    const mockSchedules = [
      { id: 'sched-1', name: 'Daily build', cronExpression: '0 9 * * *', workspaceId: 'ws-1' },
      { id: 'sched-2', name: 'Weekly deploy', cronExpression: '0 9 * * 1', workspaceId: 'ws-1' },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockTaskSchedulesFindMany.mockResolvedValue(mockSchedules);

    const request = createMockRequest();
    const mockParams = Promise.resolve({ id: 'ws-1' });
    const response = await GET(request, { params: mockParams });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.schedules).toHaveLength(2);
    expect(data.schedules[0].id).toBe('sched-1');
    expect(data.schedules[1].id).toBe('sched-2');
  });
});

describe('POST /api/workspaces/[id]/schedules', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockInsert.mockReset();
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
      method: 'POST',
      body: { name: 'Test', cronExpression: '0 9 * * *', taskTemplate: { title: 'Task' } },
    });
    const mockParams = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params: mockParams });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Test', cronExpression: '0 9 * * *', taskTemplate: { title: 'Task' } },
    });
    const mockParams = Promise.resolve({ id: 'ws-nonexistent' });
    const response = await POST(request, { params: mockParams });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns 400 when name is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const request = createMockRequest({
      method: 'POST',
      body: { cronExpression: '0 9 * * *', taskTemplate: { title: 'Task' } },
    });
    const mockParams = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params: mockParams });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('name, cronExpression, and taskTemplate.title are required');
  });

  it('returns 400 when cronExpression is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Test', taskTemplate: { title: 'Task' } },
    });
    const mockParams = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params: mockParams });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('name, cronExpression, and taskTemplate.title are required');
  });

  it('returns 400 when taskTemplate.title is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Test', cronExpression: '0 9 * * *', taskTemplate: {} },
    });
    const mockParams = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params: mockParams });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('name, cronExpression, and taskTemplate.title are required');
  });

  it('returns 400 for invalid cron expression', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockValidateCronExpression.mockReturnValue('Invalid syntax');

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Test', cronExpression: 'not-valid', taskTemplate: { title: 'Task' } },
    });
    const mockParams = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params: mockParams });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Invalid cron expression');
  });

  it('creates schedule successfully with 201 status', async () => {
    const createdSchedule = {
      id: 'sched-1',
      workspaceId: 'ws-1',
      name: 'Daily build',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      taskTemplate: { title: 'Run build' },
      nextRunAt: new Date('2026-01-01T09:00:00Z'),
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockValidateCronExpression.mockReturnValue(null);
    mockComputeNextRunAt.mockReturnValue(new Date('2026-01-01T09:00:00Z'));

    const mockReturning = mock(() => [createdSchedule]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: {
        name: 'Daily build',
        cronExpression: '0 9 * * *',
        taskTemplate: { title: 'Run build' },
      },
    });
    const mockParams = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params: mockParams });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.schedule.id).toBe('sched-1');
    expect(data.schedule.name).toBe('Daily build');
  });
});
