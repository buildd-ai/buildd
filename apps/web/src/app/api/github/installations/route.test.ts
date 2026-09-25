// Auth runs through the REAL getCurrentUser: only next-auth `auth()` and the
// users table are stubbed, so these tests pin what the helper accepts.
const originalNodeEnv = process.env.NODE_ENV;
const originalDbUrl = process.env.DATABASE_URL;
const originalDevUser = process.env.DEV_USER_EMAIL;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAuth = mock(() => null as any);
const mockIsGitHubAppConfigured = mock(() => false as boolean);
const mockFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockGetUserWorkspaceIds = mock(() => [] as string[]);
const USERS = [
  { id: 'user-1', email: 'user@test.com', name: null, image: null, timezone: null },
  { id: 'user-2', email: 'other@test.com', name: null, image: null, timezone: null },
];
const mockUsersFindFirst = mock(async ({ where }: any) => USERS.find((u) => (u as any)[where.field] === where.value) ?? null);
const mockAuthenticateApiKey = mock(async () => ({ id: 'acct-key', name: 'k', teamId: 't', level: 'admin' }) as any);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

// Mock @/auth
mock.module('@/auth', () => ({
  auth: mockAuth,
}));

// Mock @/lib/github
mock.module('@/lib/github', () => ({
  isGitHubAppConfigured: mockIsGitHubAppConfigured,
}));

// Mock @/lib/team-access
mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      users: { findFirst: mockUsersFindFirst },
      githubInstallations: {
        findMany: mockFindMany,
      },
      workspaces: {
        findMany: mockWorkspacesFindMany,
      },
    },
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  desc: (field: any) => ({ field, type: 'desc' }),
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  or: (...conditions: any[]) => ({ conditions, type: 'or' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  users: { id: 'id', email: 'email' },
  githubInstallations: {
    createdAt: 'createdAt',
    id: 'id',
    installedByUserId: 'installedByUserId',
  },
  workspaces: { id: 'id', githubInstallationId: 'githubInstallationId' },
}));

// Import handler AFTER mocks
import { GET } from './route';

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/github/installations');
}

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterAll(() => {
  restore('NODE_ENV', originalNodeEnv);
  restore('DATABASE_URL', originalDbUrl);
  restore('DEV_USER_EMAIL', originalDevUser);
});

describe('GET /api/github/installations', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockIsGitHubAppConfigured.mockReset();
    mockFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockUsersFindFirst.mockClear();
    mockAuthenticateApiKey.mockClear();
    // Keep production mode for each test
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    delete process.env.DEV_USER_EMAIL;
  });

  it('development without a DATABASE_URL keeps the placeholder', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEV_USER_EMAIL = 'user@test.com';

    const response = await GET(createRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ installations: [], configured: false });
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });

  it('development without a DEV_USER_EMAIL keeps the placeholder', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgres://example.test/db';

    const response = await GET(createRequest());
    expect(await response.json()).toEqual({ installations: [], configured: false });
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('development with a DATABASE_URL and DEV_USER_EMAIL reads as that user', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgres://example.test/db';
    process.env.DEV_USER_EMAIL = 'other@test.com';
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockGetUserWorkspaceIds.mockResolvedValue([]);
    mockFindMany.mockResolvedValue([{ id: 'inst-2' }]);

    const response = await GET(createRequest());
    expect(response.status).toBe(200);
    expect((await response.json()).installations.map((i: any) => i.id)).toEqual(['inst-2']);
    expect(mockGetUserWorkspaceIds).toHaveBeenCalledWith('user-2');
    expect(mockFindMany.mock.calls[0][0].where).toEqual({ field: 'installedByUserId', value: 'user-2', type: 'eq' });
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('returns 401 for an API key with no session — bearer credentials are not accepted here', async () => {
    mockAuth.mockResolvedValue(null);
    const response = await GET(
      new NextRequest('http://localhost:3000/api/github/installations', {
        headers: { authorization: 'Bearer bld_example' },
      }),
    );
    expect(response.status).toBe(401);
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('returns 401 for a session whose user no longer exists', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-gone' } });
    const response = await GET(createRequest());
    expect(response.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("scopes to the session user's workspaces and installs", async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-2' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockGetUserWorkspaceIds.mockResolvedValue([]);
    mockFindMany.mockResolvedValue([]);

    await GET(createRequest());
    expect(mockGetUserWorkspaceIds).toHaveBeenCalledWith('user-2');
    expect(mockFindMany.mock.calls[0][0].where).toEqual({ field: 'installedByUserId', value: 'user-2', type: 'eq' });
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET(createRequest());
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns configured:false when GitHub App not configured', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com', id: 'user-1' } });
    mockIsGitHubAppConfigured.mockReturnValue(false);

    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.installations).toEqual([]);
    expect(data.configured).toBe(false);
  });

  it('returns installations list successfully', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com', id: 'user-1' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany.mockResolvedValue([{ githubInstallationId: 'inst-1' }]);
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
      },
    ]);

    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.configured).toBe(true);
    expect(data.installations).toHaveLength(1);
    expect(data.installations[0].id).toBe('inst-1');
    expect(data.installations[0].installationId).toBe(12345);
    expect(data.installations[0].accountLogin).toBe('my-org');
  });

  // Regression: a user who installs the App before creating any workspace has no
  // workspace pointing at the installation, so the workspace-derived list is
  // empty. The route used to short-circuit to [] there — leaving the fresh
  // installation absent from Settings (unclickable "Sync") and from the
  // /workspaces/new picker, with no way out of the loop.
  it('returns installations the user installed even with no workspaces', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com', id: 'user-1' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockGetUserWorkspaceIds.mockResolvedValue([]);
    mockFindMany.mockResolvedValue([
      { id: 'inst-fresh', installationId: 1001, accountType: 'User', accountLogin: 'example-user' },
    ]);

    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.installations).toHaveLength(1);
    expect(data.installations[0].id).toBe('inst-fresh');
    // Filtered on the installer, since there are no workspace-derived ids
    expect(mockFindMany.mock.calls[0][0].where).toEqual({
      field: 'installedByUserId',
      value: 'user-1',
      type: 'eq',
    });
    expect(mockWorkspacesFindMany).not.toHaveBeenCalled();
  });

  it('unions workspace-linked installations with self-installed ones', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com', id: 'user-1' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany.mockResolvedValue([{ githubInstallationId: 'inst-1' }]);
    mockFindMany.mockResolvedValue([{ id: 'inst-1' }, { id: 'inst-2' }]);

    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.installations).toHaveLength(2);
    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.type).toBe('or');
    expect(where.conditions).toEqual([
      { field: 'id', values: ['inst-1'], type: 'inArray' },
      { field: 'installedByUserId', value: 'user-1', type: 'eq' },
    ]);
  });

  it('returns 500 on DB error', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com', id: 'user-1' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockGetUserWorkspaceIds.mockRejectedValue(new Error('DB connection failed'));

    const response = await GET(createRequest());
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toBe('Failed to get installations');
  });
});
