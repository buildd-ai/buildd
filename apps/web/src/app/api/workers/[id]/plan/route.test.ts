import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockGetCurrentUser = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockArtifactsFindFirst = mock(() => null as any);
const mockArtifactsInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'artifact-1', type: 'task_plan' }]),
  })),
}));
const mockArtifactsUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => [{ id: 'artifact-1', type: 'task_plan' }]),
    })),
  })),
}));
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => [{ id: 'worker-1', status: 'awaiting_plan_approval' }]),
    })),
  })),
}));
const mockTriggerEvent = mock(() => Promise.resolve());

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    worker: (id: string) => `worker-${id}`,
  },
  events: {
    WORKER_PROGRESS: 'worker:progress',
  },
}));

mock.module('@buildd/shared', () => ({
  ArtifactType: { TASK_PLAN: 'task_plan' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      artifacts: { findFirst: mockArtifactsFindFirst },
    },
    insert: () => mockArtifactsInsert(),
    update: (table: any) => {
      if (table === 'artifacts') return mockArtifactsUpdate();
      return mockWorkersUpdate();
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  artifacts: 'artifacts',
}));

import { GET, POST } from './route';

function createMockRequest(options: {
  method?: string;
  body?: any;
  apiKey?: string;
} = {}): NextRequest {
  const { method = 'GET', body, apiKey } = options;
  const headers: Record<string, string> = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  if (body) headers['content-type'] = 'application/json';
  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workers/worker-1/plan', init);
}

const mockParams = Promise.resolve({ id: 'worker-1' });

describe('GET /api/workers/[id]/plan', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetCurrentUser.mockReset();
    mockWorkersFindFirst.mockReset();
    mockArtifactsFindFirst.mockReset();
  });

  it('returns 401 when no auth at all', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('allows session auth to fetch plan', async () => {
    const mockPlan = { id: 'artifact-1', type: 'task_plan', content: 'Plan via session' };
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1' });
    mockArtifactsFindFirst.mockResolvedValue(mockPlan);

    const req = createMockRequest(); // No API key - session only
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plan.content).toBe('Plan via session');
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ apiKey: 'bld_test' });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 404 when no plan exists', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1' });
    mockArtifactsFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ apiKey: 'bld_test' });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('No plan found');
  });

  it('returns plan when it exists', async () => {
    const mockPlan = { id: 'artifact-1', type: 'task_plan', content: 'Step 1...' };
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1' });
    mockArtifactsFindFirst.mockResolvedValue(mockPlan);

    const req = createMockRequest({ apiKey: 'bld_test' });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plan.content).toBe('Step 1...');
  });
});

describe('POST /api/workers/[id]/plan', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetCurrentUser.mockReset();
    mockWorkersFindFirst.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockArtifactsInsert.mockReset();
    mockWorkersUpdate.mockReset();
    mockTriggerEvent.mockReset();

    mockArtifactsInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'artifact-1', type: 'task_plan' }]),
      })),
    });
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'worker-1', status: 'awaiting_plan_approval', workspaceId: 'ws-1' }]),
        })),
      })),
    });
  });

  it('returns 401 when no auth at all', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockRequest({ method: 'POST', body: { plan: 'test' } });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('allows session auth to submit plan', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      workspaceId: 'ws-1',
      task: { title: 'Test Task' },
    });
    mockArtifactsFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ method: 'POST', body: { plan: 'Session plan' } });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBe('Plan submitted successfully');
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ method: 'POST', body: { plan: 'test' }, apiKey: 'bld_test' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 403 when worker belongs to different account', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-2',
      task: { title: 'Test' },
    });

    const req = createMockRequest({ method: 'POST', body: { plan: 'test' }, apiKey: 'bld_test' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(403);
  });

  it('returns 400 when plan is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      task: { title: 'Test' },
    });

    const req = createMockRequest({ method: 'POST', body: {}, apiKey: 'bld_test' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Plan content required');
  });

  it('creates new plan when none exists', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      workspaceId: 'ws-1',
      task: { title: 'Test Task' },
    });
    mockArtifactsFindFirst.mockResolvedValue(null); // No existing plan

    const req = createMockRequest({ method: 'POST', body: { plan: 'Step 1: Do stuff' }, apiKey: 'bld_test' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBe('Plan submitted successfully');
  });

  it('updates existing plan', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      workspaceId: 'ws-1',
      task: { title: 'Test Task' },
    });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'existing-plan',
      type: 'task_plan',
      content: 'Old plan',
    });

    mockArtifactsUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'existing-plan', type: 'task_plan', content: 'Updated plan' }]),
        })),
      })),
    });

    const req = createMockRequest({ method: 'POST', body: { plan: 'Updated plan' }, apiKey: 'bld_test' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
  });

  it('triggers realtime events on plan submission', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      workspaceId: 'ws-1',
      task: { title: 'Test Task' },
    });
    mockArtifactsFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ method: 'POST', body: { plan: 'Test plan' }, apiKey: 'bld_test' });
    await POST(req, { params: mockParams });

    expect(mockTriggerEvent).toHaveBeenCalled();
  });
});
