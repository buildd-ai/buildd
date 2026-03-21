import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockWorkspacesDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  getUserTeamIds: mockGetUserTeamIds,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    update: () => mockWorkspacesUpdate(),
    delete: () => mockWorkspacesDelete(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', teamId: 'teamId' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, PATCH, DELETE } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

function createMockRequest(options: {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
} = {}): NextRequest {
  const { method = 'GET', body, headers: extraHeaders } = options;
  const headers: Record<string, string> = { ...extraHeaders };
  if (body) headers['content-type'] = 'application/json';
  const init: RequestInit = { method, headers: new Headers(headers) };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1', init);
}

describe('GET /api/workspaces/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns workspace when found', async () => {
    const mockWorkspace = {
      id: 'ws-1',
      name: 'My Workspace',
      tasks: [],
      workers: [],
    };
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue(mockWorkspace);

    const req = createMockRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspace.name).toBe('My Workspace');
  });
});

describe('PATCH /api/workspaces/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockGetUserTeamIds.mockReset();
    mockGetUserTeamIds.mockResolvedValue([]);
    process.env.NODE_ENV = 'production';

    mockWorkspacesUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockRequest({ method: 'PATCH', body: { name: 'Updated' } });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const req = createMockRequest({ method: 'PATCH', body: { name: 'Updated' } });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('updates workspace successfully', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockRequest({ method: 'PATCH', body: { name: 'Updated Name' } });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('updates workspace repo via repoUrl field', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockRequest({
      method: 'PATCH',
      body: { repoUrl: 'https://github.com/org/new-repo' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('updates workspace repo via repo field', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockRequest({
      method: 'PATCH',
      body: { repo: 'https://github.com/org/new-repo' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('updates workspace defaultBranch', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockRequest({
      method: 'PATCH',
      body: { defaultBranch: 'develop' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('allows API key auth for PATCH', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', type: 'service' });

    const req = createMockRequest({
      method: 'PATCH',
      body: { repoUrl: 'https://github.com/org/repo' },
      headers: { authorization: 'Bearer bld_testkey123' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});

describe('DELETE /api/workspaces/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesDelete.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    process.env.NODE_ENV = 'production';

    mockWorkspacesDelete.mockReturnValue({
      where: mock(() => Promise.resolve()),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockRequest({ method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const req = createMockRequest({ method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('deletes workspace successfully', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockRequest({ method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
