import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'ws-new', name: 'New Workspace' }]),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
    },
    insert: () => mockWorkspacesInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accountWorkspaces: { accountId: 'accountId' },
  workspaces: { id: 'id', ownerId: 'ownerId', createdAt: 'createdAt', accessMode: 'accessMode' },
}));

// Override NODE_ENV for tests
const originalNodeEnv = process.env.NODE_ENV;

import { GET, POST } from './route';

function createMockGetRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/workspaces', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

function createMockPostRequest(body?: any): NextRequest {
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workspaces', init);
}

describe('GET /api/workspaces', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAccountWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when no auth', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockGetRequest();
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it('returns workspaces for session auth', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindMany.mockResolvedValue([
      {
        id: 'ws-1',
        name: 'My Workspace',
        accountWorkspaces: [
          { accountId: 'acc-1', account: { type: 'user', name: 'Runner' }, canClaim: true, canCreate: false },
        ],
      },
    ]);

    const req = createMockGetRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0].name).toBe('My Workspace');
    expect(data.workspaces[0].runners).toBeDefined();
  });

  it('returns workspaces for API key auth', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountWorkspacesFindMany.mockResolvedValue([
      {
        workspace: {
          id: 'ws-1',
          name: 'Linked Workspace',
          accountWorkspaces: [],
        },
      },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([]); // No open workspaces

    const req = createMockGetRequest({ Authorization: 'Bearer bld_test' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspaces).toHaveLength(1);
  });
});

describe('POST /api/workspaces', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockWorkspacesInsert.mockReset();
    process.env.NODE_ENV = 'production';

    mockWorkspacesInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'ws-new', name: 'New Workspace' }]),
      })),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockPostRequest({ name: 'Test Workspace' });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing and no repoUrl', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockPostRequest({});
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Name is required');
  });

  it('creates workspace with name', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockPostRequest({ name: 'My Workspace' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('New Workspace');
  });

  it('auto-derives name from repoUrl', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockPostRequest({ repoUrl: 'https://github.com/user/my-repo.git' });
    const res = await POST(req);

    expect(res.status).toBe(200);
  });
});
