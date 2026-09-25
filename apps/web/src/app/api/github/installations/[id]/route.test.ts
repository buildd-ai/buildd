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
const mockFindFirst = mock(() => null as any);
const mockDeleteWhere = mock(() => Promise.resolve());
const mockDelete = mock(() => ({
  where: mockDeleteWhere,
}));

const USERS = [{ id: 'user-1', email: 'user@test.com', name: null, image: null, timezone: null }];
const mockUsersFindFirst = mock(async ({ where }: any) => USERS.find((u) => (u as any)[where.field] === where.value) ?? null);
const mockAuthenticateApiKey = mock(async () => ({ id: 'acct-key', name: 'k', teamId: 't', level: 'admin' }) as any);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

const defaultAccess = { canView: true, canManage: true, otherTeamsUsingIt: [] as string[] };
const mockGetAccess = mock(async () => defaultAccess as any);

// Mock @/auth
mock.module('@/auth', () => ({
  auth: mockAuth,
}));

mock.module('@/lib/github-installation-access', () => ({
  getInstallationAccessForUser: mockGetAccess,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      users: { findFirst: mockUsersFindFirst },
      githubInstallations: {
        findFirst: mockFindFirst,
      },
    },
    delete: mockDelete,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  users: { id: 'id', email: 'email' },
  githubInstallations: { id: 'id' },
}));

// Import handler AFTER mocks
import { DELETE } from './route';

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/github/installations/inst-1', {
    method: 'DELETE',
  });
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

describe('DELETE /api/github/installations/[id]', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockFindFirst.mockReset();
    mockDeleteWhere.mockReset();
    mockDelete.mockReset();
    mockDelete.mockImplementation(() => ({
      where: mockDeleteWhere,
    }));
    mockDeleteWhere.mockResolvedValue(undefined);
    mockGetAccess.mockReset();
    mockGetAccess.mockImplementation(async () => defaultAccess);
    mockUsersFindFirst.mockClear();
    mockAuthenticateApiKey.mockClear();
    // Keep production mode for each test
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    delete process.env.DEV_USER_EMAIL;
  });

  it('development never deletes, even with a DATABASE_URL and DEV_USER_EMAIL', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgres://example.test/db';
    process.env.DEV_USER_EMAIL = 'user@test.com';

    const response = await DELETE(createRequest(), { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });

  it('returns 401 for an API key with no session — bearer credentials are not accepted here', async () => {
    mockAuth.mockResolvedValue(null);
    const req = new NextRequest('http://localhost:3000/api/github/installations/inst-1', {
      method: 'DELETE',
      headers: { authorization: 'Bearer bld_example' },
    });
    const response = await DELETE(req, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(401);
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns 401 for a session whose user no longer exists', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-gone' } });
    const response = await DELETE(createRequest(), { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('checks access as the session user', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockFindFirst.mockResolvedValue({ id: 'inst-1', installationId: 12345, installedByUserId: null });
    await DELETE(createRequest(), { params: Promise.resolve({ id: 'inst-1' }) });
    expect(mockGetAccess.mock.calls[0][0]).toBe('user-1');
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await DELETE(createRequest(), { params: mockParams });
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when installation not found', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
    mockFindFirst.mockResolvedValue(null);

    const mockParams = Promise.resolve({ id: 'inst-nonexistent' });
    const response = await DELETE(createRequest(), { params: mockParams });
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toBe('Installation not found');
  });

  it('deletes installation successfully', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
    mockFindFirst.mockResolvedValue({
      id: 'inst-1',
      installationId: 12345,
      accountLogin: 'my-org',
    });

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await DELETE(createRequest(), { params: mockParams });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.ok).toBe(true);

    // Verify delete was called
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
  });

  it('returns 404 when the caller does not manage the installation', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
    mockFindFirst.mockResolvedValue({ id: 'inst-1', installationId: 12345, installedByUserId: null });
    mockGetAccess.mockImplementation(async () => ({ canView: true, canManage: false, otherTeamsUsingIt: [] }));

    const response = await DELETE(createRequest(), { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns 409 while workspaces in teams the caller does not administer use it', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
    mockFindFirst.mockResolvedValue({ id: 'inst-1', installationId: 12345, installedByUserId: 'user-1' });
    mockGetAccess.mockImplementation(async () => ({ canView: true, canManage: true, otherTeamsUsingIt: ['team-x'] }));

    const response = await DELETE(createRequest(), { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(409);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns 500 on DB error', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'user@test.com' } });
    mockFindFirst.mockRejectedValue(new Error('DB connection failed'));

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await DELETE(createRequest(), { params: mockParams });
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toBe('Failed to disconnect');
  });
});
