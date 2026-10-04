import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mocks (before importing the route) ────────────────────────────────────────

const mockAuthenticateApiKey = mock((_key: string | null) => Promise.resolve(null as any));
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockGetPermissions = mock(() => Promise.resolve([] as any[]));
const mockMint = mock((_p: any) => Promise.resolve({ token: 'ghs_scoped_token', expiresAt: new Date('2026-01-01T01:00:00Z') }));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/account-workspace-cache', () => ({ getAccountWorkspacePermissions: mockGetPermissions }));
mock.module('@/lib/github-scoped-token', () => ({ mintRepoScopedInstallationToken: mockMint }));
mock.module('@buildd/core/db', () => ({
  db: { query: { workers: { findFirst: mockWorkersFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'id' },
}));
mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ __eq: { f, v } }),
}));

import { POST } from './route';

// ── fixtures (illustrative) ───────────────────────────────────────────────────

const ACCOUNT = { id: 'account-1', teamId: 'team-1', level: 'worker' };

function workerRow(o: { worker?: Record<string, unknown>; workspace?: Record<string, unknown> } = {}) {
  return {
    id: 'worker-1',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    accountId: 'account-1',
    status: 'running',
    ...o.worker,
    workspace: {
      id: 'ws-1',
      teamId: 'team-1',
      accessMode: 'open',
      githubRepoId: 'repo-row-1',
      githubRepo: {
        id: 'repo-row-1', repoId: 4242, owner: 'acme', name: 'widget', fullName: 'acme/widget',
        installation: { installationId: 99, suspendedAt: null, permissions: { contents: 'write' } },
      },
      ...o.workspace,
    },
  };
}

function req(opts: { apiKey?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey !== null) headers.authorization = `Bearer ${opts.apiKey ?? 'bld_key'}`;
  return new NextRequest('http://localhost/api/runner/agent-github-token', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? { workerId: 'worker-1' }),
  });
}

beforeEach(() => {
  mockAuthenticateApiKey.mockReset();
  mockWorkersFindFirst.mockReset();
  mockGetPermissions.mockReset();
  mockMint.mockClear();
  mockAuthenticateApiKey.mockImplementation((key: string | null) => Promise.resolve(key ? ACCOUNT : null));
  mockWorkersFindFirst.mockResolvedValue(workerRow());
  mockGetPermissions.mockResolvedValue([]);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/runner/agent-github-token', () => {
  it('mints a token scoped to the repo linked to the worker\'s workspace', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      token: 'ghs_scoped_token',
      expiresAt: '2026-01-01T01:00:00.000Z',
      repository: { owner: 'acme', name: 'widget', fullName: 'acme/widget' },
    });
    // Repo identity comes from the github_repos link, never from the request.
    expect(mockMint).toHaveBeenCalledWith({ installationId: 99, repoId: 4242, installedPermissions: { contents: 'write' } });
  });

  it('ignores any repository the caller names: only the workspace link counts', async () => {
    const res = await POST(req({ body: { workerId: 'worker-1', repo: 'someone/else', repoId: 1 } }));
    expect(res.status).toBe(200);
    expect(mockMint).toHaveBeenCalledWith(expect.objectContaining({ repoId: 4242 }));
  });

  it('401 without an API key, 401 with a bad one', async () => {
    expect((await POST(req({ apiKey: null }))).status).toBe(401);
    mockAuthenticateApiKey.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(401);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('403 for a trigger token', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'trigger' });
    expect((await POST(req())).status).toBe(403);
  });

  it('400 for a missing or malformed workerId', async () => {
    expect((await POST(req({ body: {} }))).status).toBe(400);
    expect((await POST(req({ body: { workerId: '../x' } }))).status).toBe(400);
    expect((await POST(req({ body: { workerId: 5 } }))).status).toBe(400);
  });

  it('404 for an unknown worker, and for a worker another account claimed', async () => {
    mockWorkersFindFirst.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(404);
    mockWorkersFindFirst.mockResolvedValue(workerRow({ worker: { accountId: 'account-2' } }));
    expect((await POST(req())).status).toBe(404);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'cancelled'])('409 for a %s worker: tokens only while it runs', async (status) => {
    mockWorkersFindFirst.mockResolvedValue(workerRow({ worker: { status } }));
    expect((await POST(req())).status).toBe(409);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it.each(['idle', 'starting', 'running', 'waiting_input'])('accepts a %s worker', async (status) => {
    mockWorkersFindFirst.mockResolvedValue(workerRow({ worker: { status } }));
    expect((await POST(req())).status).toBe(200);
  });

  it('404 when the account lost claim authority over the workspace', async () => {
    mockWorkersFindFirst.mockResolvedValue(workerRow({ workspace: { teamId: 'team-2' } }));
    expect((await POST(req())).status).toBe(404);
    mockGetPermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
    expect((await POST(req())).status).toBe(200);
  });

  it('a workspace-restricted token is refused outside its workspaces', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, scopes: ['workers:write'], workspaceIds: ['ws-other'] });
    expect((await POST(req())).status).toBe(404);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('409 when the workspace has no linked repo, or the link is inconsistent', async () => {
    mockWorkersFindFirst.mockResolvedValue(workerRow({ workspace: { githubRepoId: null, githubRepo: null } }));
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_linked_repo');
    mockWorkersFindFirst.mockResolvedValue(workerRow({ workspace: { githubRepoId: 'other-row' } }));
    expect((await POST(req())).status).toBe(409);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('409 when the installation is suspended', async () => {
    const row = workerRow();
    (row.workspace.githubRepo.installation as any).suspendedAt = new Date();
    mockWorkersFindFirst.mockResolvedValue(row);
    expect((await POST(req())).status).toBe(409);
  });

  it('502 when GitHub refuses, without echoing the error', async () => {
    mockMint.mockImplementationOnce(() => Promise.reject(new Error('GitHub refused (HTTP 422): detail')));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('detail');
  });
});
