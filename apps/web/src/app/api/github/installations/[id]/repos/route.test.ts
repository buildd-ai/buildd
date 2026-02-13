// Ensure production mode — route short-circuits in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAuth = mock(() => null as any);
const mockInstallationsFindFirst = mock(() => null as any);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockListInstallationRepos = mock(() => [] as any[]);

// Mock @/auth
mock.module('@/auth', () => ({
  auth: mockAuth,
}));

// Mock @/lib/github
mock.module('@/lib/github', () => ({
  listInstallationRepos: mockListInstallationRepos,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: {
        findFirst: mockInstallationsFindFirst,
      },
      workspaces: {
        findMany: mockWorkspacesFindMany,
      },
    },
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  githubInstallations: { id: 'id' },
  workspaces: { githubInstallationId: 'githubInstallationId' },
}));

// Import handler AFTER mocks
import { GET } from './route';

function createGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/github/installations/inst-1/repos');
}

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('GET /api/github/installations/[id]/repos', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockInstallationsFindFirst.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockListInstallationRepos.mockReset();
    // Keep production mode for each test
    process.env.NODE_ENV = 'production';
  });

  it('returns empty repos in development mode', async () => {
    process.env.NODE_ENV = 'development';

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await GET(createGetRequest(), { params: mockParams });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.repos).toEqual([]);
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await GET(createGetRequest(), { params: mockParams });
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when installation not found', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockInstallationsFindFirst.mockResolvedValue(null);

    const mockParams = Promise.resolve({ id: 'inst-nonexistent' });
    const response = await GET(createGetRequest(), { params: mockParams });
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toBe('Installation not found');
  });

  it('returns repos from GitHub API with hasWorkspace correctly set', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockInstallationsFindFirst.mockResolvedValue({
      id: 'inst-1',
      installationId: 12345,
    });

    // GitHub API returns snake_case format
    mockListInstallationRepos.mockResolvedValue([
      {
        id: 5001,
        full_name: 'my-org/my-repo',
        name: 'my-repo',
        owner: { login: 'my-org' },
        private: false,
        default_branch: 'main',
        html_url: 'https://github.com/my-org/my-repo',
        description: 'A test repo',
      },
      {
        id: 5002,
        full_name: 'my-org/other-repo',
        name: 'other-repo',
        owner: { login: 'my-org' },
        private: true,
        default_branch: 'develop',
        html_url: 'https://github.com/my-org/other-repo',
        description: null,
      },
    ]);

    // Only first repo is linked to a workspace
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', repo: 'my-org/my-repo', githubRepoId: 'repo-1' },
    ]);

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await GET(createGetRequest(), { params: mockParams });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.repos).toHaveLength(2);

    // First repo - has workspace (linked via repo name)
    expect(data.repos[0].id).toBe('5001');
    expect(data.repos[0].repoId).toBe(5001);
    expect(data.repos[0].fullName).toBe('my-org/my-repo');
    expect(data.repos[0].name).toBe('my-repo');
    expect(data.repos[0].owner).toBe('my-org');
    expect(data.repos[0].private).toBe(false);
    expect(data.repos[0].defaultBranch).toBe('main');
    expect(data.repos[0].htmlUrl).toBe('https://github.com/my-org/my-repo');
    expect(data.repos[0].description).toBe('A test repo');
    expect(data.repos[0].hasWorkspace).toBe(true);

    // Second repo - no workspace
    expect(data.repos[1].id).toBe('5002');
    expect(data.repos[1].fullName).toBe('my-org/other-repo');
    expect(data.repos[1].hasWorkspace).toBe(false);
    expect(data.repos[1].private).toBe(true);
    expect(data.repos[1].defaultBranch).toBe('develop');

    // Verify listInstallationRepos was called with the installation's numeric ID
    expect(mockListInstallationRepos).toHaveBeenCalledWith(12345);
  });

  it('returns 500 on error', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockInstallationsFindFirst.mockResolvedValue({
      id: 'inst-1',
      installationId: 12345,
    });
    mockListInstallationRepos.mockRejectedValue(new Error('GitHub API error'));

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await GET(createGetRequest(), { params: mockParams });
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toBe('Failed to get repos');
  });
});
