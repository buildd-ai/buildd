// Ensure production mode — route short-circuits in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAuth = mock(() => null as any);
const mockIsGitHubAppConfigured = mock(() => false as boolean);
const mockFindMany = mock(() => [] as any[]);

// Mock @/auth
mock.module('@/auth', () => ({
  auth: mockAuth,
}));

// Mock @/lib/github
mock.module('@/lib/github', () => ({
  isGitHubAppConfigured: mockIsGitHubAppConfigured,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: {
        findMany: mockFindMany,
      },
    },
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  desc: (field: any) => ({ field, type: 'desc' }),
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  count: (field?: any) => ({ field, type: 'count' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  githubInstallations: { createdAt: 'createdAt', id: 'id' },
  githubRepos: { installationId: 'installationId' },
}));

// Import handler AFTER mocks
import { GET } from './route';

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/github/installations');
}

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('GET /api/github/installations', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockIsGitHubAppConfigured.mockReset();
    mockFindMany.mockReset();
    // Keep production mode for each test
    process.env.NODE_ENV = 'production';
  });

  it('returns empty installations and configured:false in development mode', async () => {
    process.env.NODE_ENV = 'development';

    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.installations).toEqual([]);
    expect(data.configured).toBe(false);
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET(createRequest());
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns empty installations and configured:false when GitHub app not configured', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockIsGitHubAppConfigured.mockReturnValue(false);

    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.installations).toEqual([]);
    expect(data.configured).toBe(false);
  });

  it('returns installations list when configured', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockFindMany.mockResolvedValue([
      {
        id: 'inst-1',
        installationId: 12345,
        accountType: 'Organization',
        accountLogin: 'my-org',
        accountAvatarUrl: 'https://avatars.githubusercontent.com/u/1',
        repositorySelection: 'all',
        suspendedAt: null,
        createdAt: '2025-01-01T00:00:00Z',
        repos: [{ id: 'repo-1' }, { id: 'repo-2' }],
      },
    ]);

    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.configured).toBe(true);
    expect(data.installations).toHaveLength(1);
    expect(data.installations[0].installationId).toBe(12345);
    expect(data.installations[0].accountLogin).toBe('my-org');
  });

  it('maps installation fields correctly including repoCount', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);

    const mockInstallation = {
      id: 'inst-1',
      installationId: 99999,
      accountType: 'User',
      accountLogin: 'test-user',
      accountAvatarUrl: 'https://avatars.githubusercontent.com/u/42',
      repositorySelection: 'selected',
      suspendedAt: '2025-06-01T00:00:00Z',
      createdAt: '2025-01-15T12:00:00Z',
      repos: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
    };

    mockFindMany.mockResolvedValue([mockInstallation]);

    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    const data = await response.json();
    const inst = data.installations[0];

    expect(inst.id).toBe('inst-1');
    expect(inst.installationId).toBe(99999);
    expect(inst.accountType).toBe('User');
    expect(inst.accountLogin).toBe('test-user');
    expect(inst.accountAvatarUrl).toBe('https://avatars.githubusercontent.com/u/42');
    expect(inst.repositorySelection).toBe('selected');
    expect(inst.repoCount).toBe(3);
    expect(inst.suspendedAt).toBe('2025-06-01T00:00:00Z');
    expect(inst.createdAt).toBe('2025-01-15T12:00:00Z');

    // Should NOT include raw repos array
    expect(inst.repos).toBeUndefined();
  });

  it('returns repoCount 0 when repos is undefined', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockFindMany.mockResolvedValue([
      {
        id: 'inst-1',
        installationId: 11111,
        accountType: 'Organization',
        accountLogin: 'no-repos-org',
        accountAvatarUrl: null,
        repositorySelection: 'all',
        suspendedAt: null,
        createdAt: '2025-01-01T00:00:00Z',
        repos: undefined,
      },
    ]);

    const response = await GET(createRequest());
    const data = await response.json();

    expect(data.installations[0].repoCount).toBe(0);
  });

  it('returns 500 when database query fails', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockFindMany.mockRejectedValue(new Error('DB connection failed'));

    const response = await GET(createRequest());
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toBe('Failed to get installations');
  });
});
