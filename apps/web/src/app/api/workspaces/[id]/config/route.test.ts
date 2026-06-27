import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * Regression test: OAuth tokens must be authorized on POST /api/workspaces/[id]/config.
 * Prior to the fix, POST only checked getCurrentUser() — OAuth JWTs have no session,
 * so they always got 401. The fix adds authenticateApiKey() dual-auth (same as PATCH
 * /api/workspaces/[id]) so an OAuth token from the owner authorizes.
 */

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
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

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
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

import { GET, POST, PATCH } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

describe('GET /api/workspaces/[id]/config', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
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
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
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
    // Auto-merge defaults off when not provided
    expect(data.gitConfig.autoMergePR).toBe(false);
  });

  it('persists autoMergePR and its safety rails', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        autoMergePR: true,
        autoMergeMaxLines: 500,
        autoMergeDenyPaths: ['drizzle/', 'src/lib/auth/', 123],
      }),
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gitConfig.autoMergePR).toBe(true);
    expect(data.gitConfig.autoMergeMaxLines).toBe(500);
    // Non-string deny-path entries are filtered out
    expect(data.gitConfig.autoMergeDenyPaths).toEqual(['drizzle/', 'src/lib/auth/']);
  });

  it('allows an OAuth JWT token (owner) to update config', async () => {
    // authenticateApiKey() resolves OAuth JWTs to an account with level='admin'
    mockAuthenticateApiKey.mockImplementation((key: string) => {
      if (key.startsWith('eyJ')) return { id: 'acc-owner', level: 'admin', teamId: 'team-1', authType: 'oauth' };
      return null;
    });
    // workspace team check passes
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', accessMode: 'restricted' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fakeJwt',
      }),
      body: JSON.stringify({ releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main' } }),
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('rejects an OAuth JWT when workspace belongs to a different team', async () => {
    mockAuthenticateApiKey.mockImplementation((key: string) => {
      if (key.startsWith('eyJ')) return { id: 'acc-owner', level: 'admin', teamId: 'team-A', authType: 'oauth' };
      return null;
    });
    // workspace owned by team-B
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-B', accessMode: 'restricted' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fakeJwt',
      }),
      body: JSON.stringify({ releaseConfig: { enabled: true } }),
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns 401 when no auth (no session, no token)', async () => {
    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ defaultBranch: 'main' }),
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('accepts trigger field in releaseConfig', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: {
          enabled: true,
          strategy: 'branch_merge',
          prodBranch: 'main',
          trigger: 'on_mission_complete',
        },
      }),
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.releaseConfig.trigger).toBe('on_mission_complete');
  });

});

describe('PATCH /api/workspaces/[id]/config', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
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
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ releaseConfig: { enabled: true } }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ releaseConfig: { enabled: true } }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns 400 when body missing releaseConfig', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ foo: 'bar' }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('saves branch_merge releaseConfig with trigger', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: {
          enabled: true,
          strategy: 'branch_merge',
          prodBranch: 'main',
          trigger: 'on_mission_complete',
        },
      }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.releaseConfig.strategy).toBe('branch_merge');
    expect(data.releaseConfig.trigger).toBe('on_mission_complete');
    expect(data.releaseConfig.prodBranch).toBe('main');
  });

  it('saves workflow_dispatch releaseConfig', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'every_merge',
        },
      }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.releaseConfig.workflowFile).toBe('release.yml');
    expect(data.releaseConfig.ref).toBe('dev');
  });

  it('rejects invalid strategy', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: { enabled: true, strategy: 'foobar' },
      }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(422);
  });

  it('rejects invalid trigger', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: { enabled: true, trigger: 'invalid_trigger' },
      }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(422);
  });

  it('strategy=none disables releases', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: { strategy: 'none' },
      }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.releaseConfig.enabled).toBe(false);
  });

  it('null releaseConfig disables releases', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ releaseConfig: null }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.releaseConfig).toBeNull();
  });

  it('accepts all valid trigger values', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    for (const trigger of ['every_merge', 'on_mission_complete', 'manual', 'scheduled']) {
      const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
        method: 'PATCH',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ releaseConfig: { enabled: true, trigger } }),
      });
      const res = await PATCH(req, { params: mockParams });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.releaseConfig.trigger).toBe(trigger);
    }
  });

  it('OAuth token with matching team can update', async () => {
    mockAuthenticateApiKey.mockImplementation((key: string) => {
      if (key.startsWith('eyJ')) return { id: 'acc-1', level: 'admin', teamId: 'team-1', authType: 'oauth' };
      return null;
    });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', accessMode: 'restricted' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fakeJwt',
      }),
      body: JSON.stringify({ releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main' } }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
  });
});

afterAll(() => mock.restore());
