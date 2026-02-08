import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockArtifactsFindFirst = mock(() => null as any);
const mockArtifactsUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => [{ id: 'worker-1', status: 'running' }]),
    })),
  })),
}));
const mockTriggerEvent = mock(() => Promise.resolve());

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    worker: (id: string) => `worker-${id}`,
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

import { POST } from './route';

function createMockRequest(body?: any, apiKey?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers(headers),
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workers/worker-1/plan/revise', init);
}

const mockParams = Promise.resolve({ id: 'worker-1' });

describe('POST /api/workers/[id]/plan/revise', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockTriggerEvent.mockReset();
    mockWorkersUpdate.mockReset();

    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'worker-1', status: 'running' }]),
        })),
      })),
    });
    mockArtifactsUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({ feedback: 'Fix it' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ feedback: 'Fix it' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 400 when worker is not awaiting plan approval', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'running',
    });

    const req = createMockRequest({ feedback: 'Fix it' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Worker is not awaiting plan approval');
  });

  it('returns 400 when feedback is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'awaiting_plan_approval',
    });

    const req = createMockRequest({}, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Feedback is required');
  });

  it('returns 404 when no plan found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'awaiting_plan_approval',
    });
    mockArtifactsFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ feedback: 'Fix it' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('No plan found to revise');
  });

  it('sends revision request and transitions worker to running', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'awaiting_plan_approval',
      workspaceId: 'ws-1',
    });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      content: 'Old plan',
      metadata: {},
    });

    const req = createMockRequest({ feedback: 'Add more tests' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toContain('Revision request sent');
  });

  it('triggers realtime events on revision request', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'awaiting_plan_approval',
      workspaceId: 'ws-1',
    });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      content: 'Plan',
      metadata: {},
    });

    const req = createMockRequest({ feedback: 'Needs work' }, 'bld_test');
    await POST(req, { params: mockParams });

    // Should trigger worker:command and worker:plan_revision_requested
    expect(mockTriggerEvent).toHaveBeenCalled();
  });
});
