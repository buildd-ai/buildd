// Ensure production mode — route short-circuits in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAuth = mock(() => null as any);
const mockIsGitHubAppConfigured = mock(() => false as boolean);
const mockFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockGetUserWorkspaceIds = mock(() => [] as string[]);

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

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('GET /api/github/installations', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockIsGitHubAppConfigured.mockReset();
    mockFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockGetUserWorkspaceIds.mockReset();
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

  it('returns configured:false when GitHub App not configured', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
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
      { id: 'inst-fresh', installationId: 155534927, accountType: 'User', accountLogin: 'maxjacu' },
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
