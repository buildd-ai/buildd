// Ensure test mode — routes short-circuit in development
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Save original NODE_ENV to restore later
const originalNodeEnv = process.env.NODE_ENV;

// Mock functions
const mockAuthenticateApiKey = mock(() => null as any);
const mockGithubApi = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockGithubReposFindFirst = mock(() => null as any);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));

// Mock api-auth
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

// Mock github
mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
    update: () => mockWorkersUpdate(),
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'id', accountId: 'accountId', prUrl: 'prUrl', prNumber: 'prNumber', updatedAt: 'updatedAt' },
  githubRepos: { id: 'id', fullName: 'fullName', defaultBranch: 'defaultBranch' },
}));

// Import handler AFTER mocks
import { POST } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { headers = {}, body } = options;
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers(headers),
  };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }
  return new NextRequest('http://localhost:3000/api/github/pr', init);
}

describe('POST /api/github/pr', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuthenticateApiKey.mockReset();
    mockGithubApi.mockReset();
    mockWorkersFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockWorkersUpdate.mockReset();

    // Restore default chain mock for update
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid API key');
  });

  it('returns 400 when workerId is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('workerId required');
  });

  it('returns 400 when title is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('title and head branch required');
  });

  it('returns 400 when head is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR' },
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('title and head branch required');
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'nonexistent', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 403 when worker belongs to different account', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-2',
      name: 'test-worker',
      workspace: {
        githubRepoId: 'repo-1',
        githubInstallationId: 'inst-1',
      },
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Worker belongs to different account');
  });

  it('returns 400 when workspace not linked to GitHub repo', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: {
        githubRepoId: null,
        githubInstallationId: null,
      },
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Workspace not linked to GitHub repo');
  });

  it('returns 404 when GitHub repo not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: {
        githubRepoId: 'repo-1',
        githubInstallationId: 'inst-1',
      },
    });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('GitHub repo not found');
  });

  it('returns 404 when GitHub repo has no installation', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: {
        githubRepoId: 'repo-1',
        githubInstallationId: 'inst-1',
      },
    });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'owner/repo',
      defaultBranch: 'main',
      installation: null,
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('GitHub repo not found');
  });

  it('creates PR successfully and returns PR data', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: {
        githubRepoId: 'repo-1',
        githubInstallationId: 'inst-1',
      },
    });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'owner/repo',
      defaultBranch: 'main',
      installation: { installationId: 12345 },
    });
    mockGithubApi.mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      title: 'My PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch', body: 'PR description' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.pr.number).toBe(42);
    expect(data.pr.url).toBe('https://github.com/owner/repo/pull/42');
    expect(data.pr.state).toBe('open');
    expect(data.pr.title).toBe('My PR');
  });

  it('updates worker with PR URL after creation', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: {
        githubRepoId: 'repo-1',
        githubInstallationId: 'inst-1',
      },
    });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'owner/repo',
      defaultBranch: 'main',
      installation: { installationId: 12345 },
    });
    mockGithubApi.mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      title: 'My PR',
    });

    let capturedSetData: any = null;
    const mockWhere = mock(() => Promise.resolve());
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockWorkersUpdate.mockReturnValue({ set: mockSet });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(capturedSetData).not.toBeNull();
    expect(capturedSetData.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(capturedSetData.prNumber).toBe(42);
    expect(capturedSetData.updatedAt).toBeInstanceOf(Date);
  });

  it('calls githubApi with correct parameters', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: {
        githubRepoId: 'repo-1',
        githubInstallationId: 'inst-1',
      },
    });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'owner/repo',
      defaultBranch: 'develop',
      installation: { installationId: 12345 },
    });
    mockGithubApi.mockResolvedValue({
      number: 10,
      html_url: 'https://github.com/owner/repo/pull/10',
      state: 'open',
      title: 'Test PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        workerId: 'w-1',
        title: 'Test PR',
        head: 'feature-branch',
        base: 'staging',
        draft: true,
        body: 'Custom body',
      },
    });
    await POST(req);

    expect(mockGithubApi).toHaveBeenCalledTimes(1);
    const [installId, path, options] = mockGithubApi.mock.calls[0];
    expect(installId).toBe(12345);
    expect(path).toBe('/repos/owner/repo/pulls');
    expect(options.method).toBe('POST');

    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.title).toBe('Test PR');
    expect(parsedBody.head).toBe('feature-branch');
    expect(parsedBody.base).toBe('staging');
    expect(parsedBody.draft).toBe(true);
    expect(parsedBody.body).toBe('Custom body');
  });

  it('defaults to dev branch when base not provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: {
        githubRepoId: 'repo-1',
        githubInstallationId: 'inst-1',
      },
    });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'owner/repo',
      defaultBranch: 'main',
      installation: { installationId: 12345 },
    });
    mockGithubApi.mockResolvedValue({
      number: 10,
      html_url: 'https://github.com/owner/repo/pull/10',
      state: 'open',
      title: 'Test PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'Test PR', head: 'feature-branch' },
    });
    await POST(req);

    const [, , options] = mockGithubApi.mock.calls[0];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.base).toBe('dev');
  });

  it('uses default body text when prBody not provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: {
        githubRepoId: 'repo-1',
        githubInstallationId: 'inst-1',
      },
    });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'owner/repo',
      defaultBranch: 'main',
      installation: { installationId: 12345 },
    });
    mockGithubApi.mockResolvedValue({
      number: 10,
      html_url: 'https://github.com/owner/repo/pull/10',
      state: 'open',
      title: 'Test PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'Test PR', head: 'feature-branch' },
    });
    await POST(req);

    const [, , options] = mockGithubApi.mock.calls[0];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.body).toBe('Created by buildd worker test-worker');
  });

  it('returns 500 when githubApi throws an error', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: {
        githubRepoId: 'repo-1',
        githubInstallationId: 'inst-1',
      },
    });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'owner/repo',
      defaultBranch: 'main',
      installation: { installationId: 12345 },
    });
    mockGithubApi.mockRejectedValue(new Error('GitHub API rate limit exceeded'));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('GitHub API rate limit exceeded');
  });
});
