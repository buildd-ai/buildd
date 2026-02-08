import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockWorkspacesDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
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
  workspaces: { id: 'id', ownerId: 'ownerId' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, PATCH, DELETE } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

function createMockRequest(options: {
  method?: string;
  body?: any;
} = {}): NextRequest {
  const { method = 'GET', body } = options;
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  const init: RequestInit = { method, headers: new Headers(headers) };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1', init);
}

describe('GET /api/workspaces/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
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
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesUpdate.mockReset();
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
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ method: 'PATCH', body: { name: 'Updated' } });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('updates workspace successfully', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = createMockRequest({ method: 'PATCH', body: { name: 'Updated Name' } });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});

describe('DELETE /api/workspaces/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesDelete.mockReset();
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
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('deletes workspace successfully', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = createMockRequest({ method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
