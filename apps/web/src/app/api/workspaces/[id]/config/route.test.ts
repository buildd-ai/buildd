import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    update: () => mockWorkspacesUpdate(),
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

import { GET, POST } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

describe('GET /api/workspaces/[id]/config', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated and no API key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('allows Bearer token auth', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      gitConfig: { defaultBranch: 'main' },
      configStatus: 'admin_confirmed',
    });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      headers: new Headers({ Authorization: 'Bearer bld_test' }),
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gitConfig).toBeDefined();
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns config when workspace found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      gitConfig: {
        defaultBranch: 'main',
        branchingStrategy: 'feature',
      },
      configStatus: 'admin_confirmed',
    });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gitConfig.defaultBranch).toBe('main');
    expect(data.configStatus).toBe('admin_confirmed');
  });
});

describe('POST /api/workspaces/[id]/config', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
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

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ defaultBranch: 'main' }),
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ defaultBranch: 'main' }),
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('saves git config successfully', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        defaultBranch: 'develop',
        branchingStrategy: 'gitflow',
        requiresPR: true,
        autoCreatePR: true,
      }),
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.gitConfig.defaultBranch).toBe('develop');
    expect(data.gitConfig.branchingStrategy).toBe('gitflow');
    expect(data.gitConfig.requiresPR).toBe(true);
  });

  it('uses defaults for missing fields', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gitConfig.defaultBranch).toBe('main');
    expect(data.gitConfig.branchingStrategy).toBe('feature');
  });
});
