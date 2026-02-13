// Ensure production mode — routes short-circuit in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAuthenticateApiKey = mock(() => null as any);
const mockGithubReposFindFirst = mock(() => null as any);

// Mock api-auth
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id' },
  githubRepos: { fullName: 'fullName' },
}));

// Import handlers AFTER mocks
import { GET } from './route';

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

// Helper to create mock NextRequest
function createMockRequest(options: {
  headers?: Record<string, string>;
  searchParams?: Record<string, string>;
} = {}): NextRequest {
  const { headers = {}, searchParams = {} } = options;

  let url = 'http://localhost:3000/api/workspaces/by-repo';
  const params = new URLSearchParams(searchParams);
  if (params.toString()) {
    url += `?${params.toString()}`;
  }

  return new NextRequest(url, {
    method: 'GET',
    headers: new Headers(headers),
  });
}

describe('GET /api/workspaces/by-repo', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuthenticateApiKey.mockReset();
    mockGithubReposFindFirst.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await GET(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 when repo param missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
    });
    const response = await GET(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('repo parameter required');
  });

  it('returns null workspace when repo not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      searchParams: { repo: 'owner/nonexistent-repo' },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.workspace).toBeNull();
  });

  it('returns null workspace when repo has no workspaces', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'owner/repo',
      workspaces: [],
    });

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      searchParams: { repo: 'owner/repo' },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.workspace).toBeNull();
  });

  it('returns workspace when found', async () => {
    const mockWorkspace = {
      id: 'ws-1',
      name: 'My Workspace',
      repoFullName: 'owner/repo',
    };

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'owner/repo',
      workspaces: [mockWorkspace],
    });

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      searchParams: { repo: 'owner/repo' },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.workspace).toEqual(mockWorkspace);
    expect(data.workspace.id).toBe('ws-1');
  });
});
