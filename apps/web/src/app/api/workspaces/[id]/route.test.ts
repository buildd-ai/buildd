import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockGithubReposFindFirst = mock(() => null as any);
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

let capturedUpdates: Record<string, unknown> = {};

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
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
    update: () => mockWorkspacesUpdate(),
    delete: () => mockWorkspacesDelete(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  ilike: (field: any, value: any) => ({ field, value, type: 'ilike' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', teamId: 'teamId' },
  githubRepos: { fullName: 'fullName' },
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
    mockGithubReposFindFirst.mockReset();
    mockGithubReposFindFirst.mockResolvedValue(null);
    mockWorkspacesUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockGetUserTeamIds.mockReset();
    mockGetUserTeamIds.mockResolvedValue([]);
    capturedUpdates = {};
    process.env.NODE_ENV = 'production';

    mockWorkspacesUpdate.mockReturnValue({
      set: mock((updates: Record<string, unknown>) => {
        capturedUpdates = updates;
        return { where: mock(() => Promise.resolve()) };
      }),
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

  it('updates maxConcurrentTasks, clamping below 1 up to 1', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockRequest({ method: 'PATCH', body: { maxConcurrentTasks: 5 } });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    expect(capturedUpdates.maxConcurrentTasks).toBe(5);

    const req2 = createMockRequest({ method: 'PATCH', body: { maxConcurrentTasks: 0 } });
    await PATCH(req2, { params: mockParams });
    expect(capturedUpdates.maxConcurrentTasks).toBe(1);
  });

  // ── connectorAdvisoryMode ──────────────────────────────────────────────────
  // The degraded-mode claim path (connector-prefilter.ts) is gated entirely on
  // this column, and it had no writer anywhere: the flag could never be true, so
  // the tested advisory behaviour was unreachable in production. These tests pin
  // the writer, including the strict-boolean rule — a coerced value would let the
  // string "false" switch a claim gate off.

  it('turns connector advisory mode on', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockRequest({ method: 'PATCH', body: { connectorAdvisoryMode: true } });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedUpdates.connectorAdvisoryMode).toBe(true);
  });

  it('turns connector advisory mode back off — false is a value, not an absence', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockRequest({ method: 'PATCH', body: { connectorAdvisoryMode: false } });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedUpdates).toHaveProperty('connectorAdvisoryMode', false);
  });

  it('rejects a non-boolean connectorAdvisoryMode instead of coercing it', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    for (const value of ['true', 'false', 1, 0, null]) {
      const req = createMockRequest({ method: 'PATCH', body: { connectorAdvisoryMode: value } });
      const res = await PATCH(req, { params: mockParams });
      expect(res.status).toBe(400);
      expect(capturedUpdates).not.toHaveProperty('connectorAdvisoryMode');
    }
  });

  it('leaves the flag untouched when the field is absent', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockRequest({ method: 'PATCH', body: { name: 'Renamed' } });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedUpdates).not.toHaveProperty('connectorAdvisoryMode');
  });

  it('refuses to set the flag for a caller with no access to the workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const req = createMockRequest({ method: 'PATCH', body: { connectorAdvisoryMode: true } });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(404);
    expect(capturedUpdates).not.toHaveProperty('connectorAdvisoryMode');
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

  it('allows API key auth for PATCH when workspace belongs to team', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', type: 'service', teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });

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

  it('merges partial gitConfig via API key auth, preserving existing fields', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', type: 'service', teamId: 'team-1' });
    // Same mock answers the team check (teamId) and the gitConfig merge read.
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', gitConfig: { defaultBranch: 'dev', autoCreatePR: true } });

    const req = createMockRequest({
      method: 'PATCH',
      body: { gitConfig: { autoMergePR: true } },
      headers: { authorization: 'Bearer bld_testkey123' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    // Existing fields preserved, new flag merged in
    expect(capturedUpdates.gitConfig).toEqual({ defaultBranch: 'dev', autoCreatePR: true, autoMergePR: true });
  });

  it('returns 404 when API key team does not match workspace team', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', type: 'service', teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-other' });

    const req = createMockRequest({
      method: 'PATCH',
      body: { name: 'Hijack' },
      headers: { authorization: 'Bearer bld_testkey123' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 404 when API key workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', type: 'service', teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      method: 'PATCH',
      body: { name: 'Ghost' },
      headers: { authorization: 'Bearer bld_testkey123' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('auto-links githubRepoId when repoUrl matches a known GitHub repo', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'github-repo-uuid',
      installationId: 'installation-uuid',
      fullName: 'buildd-ai/dispatch',
    });

    const req = createMockRequest({
      method: 'PATCH',
      body: { repoUrl: 'https://github.com/buildd-ai/dispatch' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedUpdates.repo).toBe('https://github.com/buildd-ai/dispatch');
    expect(capturedUpdates.githubRepoId).toBe('github-repo-uuid');
    expect(capturedUpdates.githubInstallationId).toBe('installation-uuid');
  });

  it('sets repo without githubRepoId when no matching GitHub repo found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      method: 'PATCH',
      body: { repoUrl: 'https://github.com/some-org/unknown-repo' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedUpdates.repo).toBe('https://github.com/some-org/unknown-repo');
    expect(capturedUpdates.githubRepoId).toBeUndefined();
    expect(capturedUpdates.githubInstallationId).toBeUndefined();
  });

  it('accepts a valid gitConfig.mergePolicy', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', gitConfig: {} });

    const req = createMockRequest({
      method: 'PATCH',
      body: { gitConfig: { mergePolicy: { tier: 'human' } } },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedUpdates.gitConfig).toMatchObject({ mergePolicy: { tier: 'human' } });
  });

  it('accepts null gitConfig.mergePolicy to clear policy', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', gitConfig: { mergePolicy: { tier: 'human' } } });

    const req = createMockRequest({
      method: 'PATCH',
      body: { gitConfig: { mergePolicy: null } },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedUpdates.gitConfig).toMatchObject({ mergePolicy: null });
  });

  it('rejects gitConfig.mergePolicy with unknown keys (returns 400)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', gitConfig: {} });

    const req = createMockRequest({
      method: 'PATCH',
      body: { gitConfig: { mergePolicy: { tier: 'human', bogusField: true } } },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/gitConfig\.mergePolicy/);
  });

  it('rejects gitConfig.mergePolicy with invalid tier (returns 400)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', gitConfig: {} });

    const req = createMockRequest({
      method: 'PATCH',
      body: { gitConfig: { mergePolicy: { tier: 'not-a-tier' } } },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/gitConfig\.mergePolicy/);
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
