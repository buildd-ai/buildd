import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockArtifactsFindFirst = mock(() => null as any);
const mockArtifactsFindMany = mock(() => [] as any);
const mockArtifactsInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'artifact-1', shareToken: 'test-token' }]),
  })),
}));
const mockArtifactsUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => [{ id: 'artifact-1', shareToken: 'test-token' }]),
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
    worker: (id: string) => `worker-${id}`,
    workspace: (id: string) => `workspace-${id}`,
  },
  events: {
    WORKER_PROGRESS: 'worker:progress',
  },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      artifacts: { findFirst: mockArtifactsFindFirst, findMany: mockArtifactsFindMany },
    },
    insert: () => mockArtifactsInsert(),
    update: () => mockArtifactsUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  artifacts: 'artifacts',
}));

mock.module('@buildd/shared', () => ({
  ArtifactType: {
    CONTENT: 'content',
    REPORT: 'report',
    DATA: 'data',
    LINK: 'link',
    SUMMARY: 'summary',
  },
}));

mock.module('crypto', () => ({
  randomBytes: () => ({ toString: () => 'random-share-token' }),
}));

import { GET, POST } from './route';

function createMockGetRequest(apiKey?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest('http://localhost:3000/api/workers/worker-1/artifacts', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

function createMockPostRequest(body?: any, apiKey?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers(headers),
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workers/worker-1/artifacts', init);
}

const mockParams = Promise.resolve({ id: 'worker-1' });

describe('GET /api/workers/[id]/artifacts', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockArtifactsFindMany.mockReset();
    mockArtifactsFindMany.mockResolvedValue([]);
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockGetRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 403 when worker belongs to different account', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-2',
    });

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
  });

  it('returns artifacts when authenticated and authorized', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
    });
    const mockArtifacts = [
      { id: 'art-1', type: 'content', title: 'Test' },
    ];
    mockArtifactsFindMany.mockResolvedValue(mockArtifacts);

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifacts).toHaveLength(1);
    expect(data.artifacts[0].title).toBe('Test');
  });
});

describe('POST /api/workers/[id]/artifacts', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockArtifactsInsert.mockReset();
    mockArtifactsUpdate.mockReset();
    mockTriggerEvent.mockReset();
    mockArtifactsFindFirst.mockResolvedValue(null);
    mockArtifactsInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'artifact-1', shareToken: 'test-token', type: 'content', title: 'Test' }]),
      })),
    });
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockPostRequest({ type: 'content', title: 'Test' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockPostRequest({ type: 'content', title: 'Test' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 403 when worker belongs to different account', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-2',
      task: { id: 'task-1' },
    });

    const req = createMockPostRequest({ type: 'content', title: 'Test' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
  });

  it('returns 400 for invalid artifact type', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      task: { id: 'task-1' },
    });

    const req = createMockPostRequest({ type: 'invalid', title: 'Test' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Invalid type');
  });

  it('returns 400 when title is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      task: { id: 'task-1' },
    });

    const req = createMockPostRequest({ type: 'content' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('title is required');
  });

  it('returns 400 when link type has no url', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      task: { id: 'task-1' },
    });

    const req = createMockPostRequest({ type: 'link', title: 'My Link' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('url is required for link artifacts');
  });

  it('creates artifact successfully', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      workspaceId: 'ws-1',
      task: { id: 'task-1' },
    });

    const req = createMockPostRequest(
      { type: 'content', title: 'Test Artifact', content: 'Some content' },
      'bld_test'
    );
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifact).toBeDefined();
    expect(mockTriggerEvent).toHaveBeenCalled();
  });
});
