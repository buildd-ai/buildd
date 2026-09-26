// Auth runs through the REAL getCurrentUser: only next-auth `auth()` and the
// users table are stubbed, so these tests pin what the helper accepts.
const originalNodeEnv = process.env.NODE_ENV;
const originalDbUrl = process.env.DATABASE_URL;
const originalDevUser = process.env.DEV_USER_EMAIL;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuth = mock(() => null as any);
const mockInstallationsFindFirst = mock(() => null as any);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockListInstallationRepos = mock(() => [] as any[]);
const mockSyncInstallationRepos = mock(() => ({ synced: 0, linked: 0, linkedWorkspaceIds: [] }) as any);

const USERS = [{ id: 'user-1', email: 'user@test.com', name: null, image: null, timezone: null }];
const mockUsersFindFirst = mock(async ({ where }: any) => USERS.find((u) => (u as any)[where.field] === where.value) ?? null);
const mockAuthenticateApiKey = mock(async () => ({ id: 'acct-key', name: 'k', teamId: 't', level: 'admin' }) as any);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

const defaultAccess = { canView: true, canManage: true, otherTeamsUsingIt: [] as string[] };
const mockGetAccess = mock(async () => defaultAccess as any);
mock.module('@/lib/github-installation-access', () => ({ getInstallationAccessForUser: mockGetAccess }));
mock.module('@/auth', () => ({ auth: mockAuth }));
mock.module('@/lib/github', () => ({ listInstallationRepos: mockListInstallationRepos }));
mock.module('@/lib/github-repo-link', () => ({ syncInstallationRepos: mockSyncInstallationRepos }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      users: { findFirst: mockUsersFindFirst },
      githubInstallations: { findFirst: mockInstallationsFindFirst },
      workspaces: { findMany: mockWorkspacesFindMany },
    },
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  users: { id: 'id', email: 'email' },
  githubInstallations: { id: 'id' },
  workspaces: { githubInstallationId: 'githubInstallationId' },
}));

import { GET, POST } from './route';

function createGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/github/installations/inst-1/repos');
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

describe('GET /api/github/installations/[id]/repos', () => {
  const mockParams = Promise.resolve({ id: 'inst-1' });

  beforeEach(() => {
    mockAuth.mockReset();
    mockInstallationsFindFirst.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockListInstallationRepos.mockReset();
    mockSyncInstallationRepos.mockReset();
    mockGetAccess.mockReset();
    mockGetAccess.mockImplementation(async () => defaultAccess);
    mockUsersFindFirst.mockClear();
    mockAuthenticateApiKey.mockClear();
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    delete process.env.DEV_USER_EMAIL;
  });

  // Listing repos mints a GitHub installation token and, when the cached one
  // is near expiry, persists the new one to github_installations
  // (getInstallationToken). A read that writes stays gated in dev.
  it('development keeps the placeholder even with a DATABASE_URL and DEV_USER_EMAIL', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgres://example.test/db';
    process.env.DEV_USER_EMAIL = 'user@test.com';

    const response = await GET(createGetRequest(), { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ repos: [] });
    expect(mockListInstallationRepos).not.toHaveBeenCalled();
    expect(mockInstallationsFindFirst).not.toHaveBeenCalled();
  });

  it('POST in development never syncs, even with a DATABASE_URL and DEV_USER_EMAIL', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgres://example.test/db';
    process.env.DEV_USER_EMAIL = 'user@test.com';

    const response = await POST(
      new NextRequest('http://localhost:3000/api/github/installations/inst-1/repos', { method: 'POST' }),
      { params: Promise.resolve({ id: 'inst-1' }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ synced: 0, linked: 0, linkedWorkspaceIds: [] });
    expect(mockSyncInstallationRepos).not.toHaveBeenCalled();
    expect(mockInstallationsFindFirst).not.toHaveBeenCalled();
  });

  it('GET and POST return 401 for an API key with no session — bearer credentials are not accepted here', async () => {
    mockAuth.mockResolvedValue(null);
    const headers = { authorization: 'Bearer bld_example' };
    const url = 'http://localhost:3000/api/github/installations/inst-1/repos';
    const g = await GET(new NextRequest(url, { headers }), { params: Promise.resolve({ id: 'inst-1' }) });
    const p = await POST(new NextRequest(url, { method: 'POST', headers }), { params: Promise.resolve({ id: 'inst-1' }) });
    expect(g.status).toBe(401);
    expect(p.status).toBe(401);
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
    expect(mockListInstallationRepos).not.toHaveBeenCalled();
    expect(mockSyncInstallationRepos).not.toHaveBeenCalled();
  });

  it('returns 401 for a session whose user no longer exists', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-gone' } });
    const response = await GET(createGetRequest(), { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(401);
    expect(mockInstallationsFindFirst).not.toHaveBeenCalled();
  });

  it('checks access as the session user', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockInstallationsFindFirst.mockResolvedValue({ id: 'inst-1', installationId: 12345, installedByUserId: null });
    mockGetAccess.mockImplementation(async () => ({ canView: false, canManage: false, otherTeamsUsingIt: [] }));
    const response = await GET(createGetRequest(), { params: Promise.resolve({ id: 'inst-1' }) });
    expect(mockGetAccess.mock.calls[0][0]).toBe('user-1');
    // Denied: canView false → 404, and GitHub is never called (no token minted).
    expect(response.status).toBe(404);
    expect(mockListInstallationRepos).not.toHaveBeenCalled();
    expect(mockWorkspacesFindMany).not.toHaveBeenCalled();
  });

  it('POST denied for the session user: canView false → 404, nothing synced', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockInstallationsFindFirst.mockResolvedValue({ id: 'inst-1', installationId: 12345, installedByUserId: null });
    mockGetAccess.mockImplementation(async () => ({ canView: false, canManage: false, otherTeamsUsingIt: [] }));
    const response = await POST(
      new NextRequest('http://localhost:3000/api/github/installations/inst-1/repos', { method: 'POST' }),
      { params: Promise.resolve({ id: 'inst-1' }) },
    );
    expect(mockGetAccess.mock.calls[0][0]).toBe('user-1');
    expect(response.status).toBe(404);
    expect(mockSyncInstallationRepos).not.toHaveBeenCalled();
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
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
    mockInstallationsFindFirst.mockResolvedValue(null);

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await GET(createGetRequest(), { params: mockParams });
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toBe('Installation not found');
  });

  it('returns 404 when the caller cannot view the installation', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
    mockInstallationsFindFirst.mockResolvedValue({ id: 'inst-1', installationId: 12345, installedByUserId: null });
    mockGetAccess.mockImplementation(async () => ({ canView: false, canManage: false, otherTeamsUsingIt: [] }));

    const response = await GET(createGetRequest(), { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(404);
    expect(mockListInstallationRepos).not.toHaveBeenCalled();
  });

  it('POST returns 404 when the caller cannot view the installation', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
    mockInstallationsFindFirst.mockResolvedValue({ id: 'inst-1', installationId: 12345, installedByUserId: null });
    mockGetAccess.mockImplementation(async () => ({ canView: false, canManage: false, otherTeamsUsingIt: [] }));

    const response = await POST(new NextRequest('http://localhost:3000/api/github/installations/inst-1/repos', { method: 'POST' }), { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(404);
    expect(mockSyncInstallationRepos).not.toHaveBeenCalled();
  });

  it('returns repos with hasWorkspace correctly mapped', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
    mockInstallationsFindFirst.mockResolvedValue({
      id: 'inst-1',
      installationId: 12345,
    });

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

    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', repo: 'my-org/my-repo', githubRepoId: 'repo-1' },
    ]);

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await GET(createGetRequest(), { params: mockParams });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.repos).toHaveLength(2);

    // First repo — linked workspace exists
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

    // Second repo — no linked workspace
    expect(data.repos[1].id).toBe('5002');
    expect(data.repos[1].repoId).toBe(5002);
    expect(data.repos[1].fullName).toBe('my-org/other-repo');
    expect(data.repos[1].hasWorkspace).toBe(false);
    expect(data.repos[1].private).toBe(true);
    expect(data.repos[1].defaultBranch).toBe('develop');
    expect(data.repos[1].description).toBeNull();

    // Verify listInstallationRepos was called with the installation's numeric ID
    expect(mockListInstallationRepos).toHaveBeenCalledWith(12345);
  });

  it('POST returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/github/installations/inst-1/repos', {
      method: 'POST',
    });
    const response = await POST(req, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(401);
  });

  it('POST returns synced, linked, and linkedWorkspaceIds on success', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
    mockInstallationsFindFirst.mockResolvedValue({ id: 'inst-1', installationId: 12345 });
    mockSyncInstallationRepos.mockResolvedValue({
      synced: 3,
      linked: 2,
      linkedWorkspaceIds: ['ws-1', 'ws-2'],
    });

    const req = new NextRequest('http://localhost:3000/api/github/installations/inst-1/repos', {
      method: 'POST',
    });
    const response = await POST(req, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.synced).toBe(3);
    expect(data.linked).toBe(2);
    expect(data.linkedWorkspaceIds).toEqual(['ws-1', 'ws-2']);
  });

  it('POST returns linked=0 with empty linkedWorkspaceIds when no workspace repo matches', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
    mockInstallationsFindFirst.mockResolvedValue({ id: 'inst-1', installationId: 12345 });
    mockSyncInstallationRepos.mockResolvedValue({
      synced: 5,
      linked: 0,
      linkedWorkspaceIds: [],
    });

    const req = new NextRequest('http://localhost:3000/api/github/installations/inst-1/repos', {
      method: 'POST',
    });
    const response = await POST(req, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.synced).toBe(5);
    expect(data.linked).toBe(0);
    expect(data.linkedWorkspaceIds).toEqual([]);
  });

  it('returns 500 on error', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
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
