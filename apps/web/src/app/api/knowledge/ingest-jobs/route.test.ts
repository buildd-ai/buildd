process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(async () => null as any);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

const mockEnqueueFullIngestJob = mock(async () => 'job-id-1' as string | null);
mock.module('@/lib/knowledge-ingest', () => ({
  enqueueFullIngestJob: mockEnqueueFullIngestJob,
}));

// Shared return value for the join query (workspaces → githubRepos).
let joinResult: Array<{ repoFullName: string }> = [{ repoFullName: 'test-org/test-repo' }];
// Return value for list queries (GET handler).
let listResult: Array<Record<string, unknown>> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve(joinResult),
          }),
        }),
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(listResult),
          }),
        }),
        orderBy: () => ({
          limit: () => Promise.resolve(listResult),
        }),
      }),
    }),
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', githubRepoId: 'githubRepoId' },
  githubRepos: { id: 'id', fullName: 'fullName' },
  knowledgeIngestJobs: { workspaceId: 'workspaceId', createdAt: 'createdAt' },
}));

import { POST, GET } from './route';

function makeRequest(method: string, body?: unknown, search = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/knowledge/ingest-jobs${search}`, {
    method,
    headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_test' }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const adminAccount = { id: 'account-1', level: 'admin', authType: 'api' };

describe('POST /api/knowledge/ingest-jobs', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockEnqueueFullIngestJob.mockReset();
    mockEnqueueFullIngestJob.mockResolvedValue('job-id-1');
    joinResult = [{ repoFullName: 'test-org/test-repo' }];
  });

  it('returns 401 without a valid API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(makeRequest('POST', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin tokens', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...adminAccount, level: 'worker' });
    const res = await POST(makeRequest('POST', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when workspaceId is missing', async () => {
    const res = await POST(makeRequest('POST', {}));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost:3000/api/knowledge/ingest-jobs', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_test' }),
      body: 'not-json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 422 when workspace has no linked github repo', async () => {
    joinResult = [];
    const res = await POST(makeRequest('POST', { workspaceId: 'ws-no-repo' }));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.reason).toBe('no_github_repo');
  });

  it('returns 200 with already_queued when enqueue returns null', async () => {
    mockEnqueueFullIngestJob.mockResolvedValue(null);
    const res = await POST(makeRequest('POST', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job).toBeNull();
    expect(data.reason).toBe('already_queued');
  });

  it('returns 201 with job when successfully enqueued', async () => {
    const res = await POST(makeRequest('POST', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.job.id).toBe('job-id-1');
    expect(data.job.workspaceId).toBe('ws-1');
    expect(data.job.repo).toBe('test-org/test-repo');
    expect(data.job.trigger).toBe('manual');
    expect(data.job.scope).toBe('full');
    expect(data.job.status).toBe('queued');
  });

  it('calls enqueueFullIngestJob with correct params', async () => {
    await POST(makeRequest('POST', { workspaceId: 'ws-abc' }));
    expect(mockEnqueueFullIngestJob).toHaveBeenCalledWith({
      workspaceId: 'ws-abc',
      repo: 'test-org/test-repo',
      trigger: 'manual',
    });
  });
});

describe('GET /api/knowledge/ingest-jobs', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    listResult = [];
  });

  it('returns 401 without a valid API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin tokens', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...adminAccount, level: 'worker' });
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(403);
  });

  it('returns empty jobs array when no jobs exist', async () => {
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.jobs)).toBe(true);
    expect(data.jobs).toHaveLength(0);
  });

  it('returns jobs when they exist', async () => {
    listResult = [{ id: 'job-1', workspaceId: 'ws-1', status: 'done' }];
    const res = await GET(makeRequest('GET'));
    const data = await res.json();
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].id).toBe('job-1');
  });

  it('accepts workspaceId query param', async () => {
    listResult = [{ id: 'job-1', workspaceId: 'ws-1', status: 'queued' }];
    const res = await GET(makeRequest('GET', undefined, '?workspaceId=ws-1'));
    const data = await res.json();
    expect(data.jobs).toHaveLength(1);
  });
});
