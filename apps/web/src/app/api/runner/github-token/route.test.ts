import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mocks (before importing the route) ────────────────────────────────────────

const mockAuthenticateApiKey = mock((_key: string | null) => Promise.resolve(null as any));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockWorkersFindMany = mock(() => Promise.resolve([] as any[]));
const mockGetPermissions = mock(() => Promise.resolve([] as any[]));
const mockMint = mock((_p: any) => Promise.resolve({ token: 'ghs_scoped_token', expiresAt: new Date('2026-01-01T01:00:00Z') }));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/account-workspace-cache', () => ({ getAccountWorkspacePermissions: mockGetPermissions }));
mock.module('@/lib/github-scoped-token', () => ({ mintRepoScopedInstallationToken: mockMint }));
const mockRecord = mock((_r: any) => Promise.resolve());
mock.module('@/lib/agent-capabilities/audit', () => ({ recordCapabilityDecision: mockRecord }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findMany: mockWorkersFindMany },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id' },
  workers: { taskId: 'task_id', status: 'status' },
  workspaces: { id: 'id', teamId: 'team_id', accessMode: 'access_mode' },
  accountWorkspaces: { accountId: 'account_id', workspaceId: 'workspace_id' },
}));
mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ __eq: { f, v } }),
  and: (...c: any[]) => ({ __and: c }),
  inArray: (f: any, v: any) => ({ __in: { f, v } }),
}));

import { POST } from './route';

// ── fixtures ──────────────────────────────────────────────────────────────────

const ACCOUNT = { id: 'account-1', teamId: 'team-1', level: 'worker' };
const DISPATCH = 'dispatch-token-value';

function taskRow(overrides: { workspace?: Record<string, unknown> } = {}) {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    workspace: {
      id: 'ws-1',
      teamId: 'team-1',
      accessMode: 'open',
      webhookConfig: { url: 'https://dispatcher.example/dispatch', token: DISPATCH, enabled: true },
      githubRepoId: 'repo-row-1',
      githubRepo: {
        id: 'repo-row-1', repoId: 4242, owner: 'acme', name: 'widget', fullName: 'acme/widget',
        installation: { installationId: 99, suspendedAt: null, permissions: { contents: 'write' } },
      },
      ...overrides.workspace,
    },
  };
}

const liveWorker = (o: Record<string, unknown> = {}) => ({
  id: 'worker-1', taskId: 'task-1', workspaceId: 'ws-1', accountId: 'account-1', status: 'running', ...o,
});

function req(opts: { apiKey?: string | null; dispatch?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey !== null) headers.authorization = `Bearer ${opts.apiKey ?? 'bld_key'}`;
  if (opts.dispatch !== null) headers['x-buildd-dispatch-token'] = opts.dispatch ?? DISPATCH;
  return new NextRequest('http://localhost/api/runner/github-token', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? { taskId: 'task-1' }),
  });
}

beforeEach(() => {
  mockAuthenticateApiKey.mockReset();
  mockTasksFindFirst.mockReset();
  mockWorkersFindMany.mockReset();
  mockGetPermissions.mockReset();
  mockMint.mockClear();
  mockRecord.mockClear();
  // Like the real one: no key, no account.
  mockAuthenticateApiKey.mockImplementation((key: string | null) => Promise.resolve(key ? ACCOUNT : null));
  mockTasksFindFirst.mockResolvedValue(taskRow());
  mockWorkersFindMany.mockResolvedValue([liveWorker()]);
  mockGetPermissions.mockResolvedValue([]);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/runner/github-token', () => {
  it('mints a token scoped to the workspace-linked repo', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      token: 'ghs_scoped_token',
      expiresAt: '2026-01-01T01:00:00.000Z',
      repository: { owner: 'acme', name: 'widget', fullName: 'acme/widget' },
      // The cloud runner keys its per-workspace snapshots by this, so the
      // container can never choose whose snapshot it reads (warm repos).
      workspaceId: 'ws-1',
      // protectedBaseBranches() includes 'main' unconditionally even with no
      // gitConfig/releaseConfig set (see auto-merge-bound.ts).
      protectedBranches: ['main'],
    });
    // Repo identity from the github_repos link, not free text.
    expect(mockMint).toHaveBeenCalledWith({ installationId: 99, repoId: 4242, installedPermissions: { contents: 'write' } });
  });

  it('protectedBranches combines gitConfig.defaultBranch, releaseConfig.prodBranch and the repo\'s own default branch, deduped', async () => {
    mockTasksFindFirst.mockResolvedValue(taskRow({
      workspace: {
        gitConfig: { defaultBranch: 'dev', branchingStrategy: 'trunk', commitStyle: 'conventional', requiresPR: true, autoCreatePR: true, useClaudeMd: true },
        releaseConfig: { enabled: true, prodBranch: 'main' },
        githubRepo: { id: 'repo-row-1', repoId: 4242, owner: 'acme', name: 'widget', fullName: 'acme/widget', defaultBranch: 'master', installation: { installationId: 99, suspendedAt: null, permissions: { contents: 'write' } } },
      },
    }));
    const body = await (await POST(req())).json();
    expect(new Set(body.protectedBranches)).toEqual(new Set(['main', 'dev', 'master']));
  });

  it('carries the workspace warm snapshot cap from gitConfig.warmSnapshot.maxBytes, bounded server-side', async () => {
    const withCap = (maxBytes: unknown) => taskRow({
      workspace: {
        gitConfig: { defaultBranch: 'main', branchingStrategy: 'trunk', commitStyle: 'conventional', requiresPR: true, autoCreatePR: true, useClaudeMd: true, warmSnapshot: { maxBytes } },
        githubRepo: { id: 'repo-row-1', repoId: 4242, owner: 'acme', name: 'widget', fullName: 'acme/widget', defaultBranch: 'main', installation: { installationId: 99, suspendedAt: null, permissions: { contents: 'write' } } },
      },
    });
    mockTasksFindFirst.mockResolvedValue(withCap(3 * 1024 ** 3));
    expect((await (await POST(req())).json()).warmSnapshotMaxBytes).toBe(3 * 1024 ** 3);
    mockTasksFindFirst.mockResolvedValue(withCap(100 * 1024 ** 3));
    expect((await (await POST(req())).json()).warmSnapshotMaxBytes).toBe(8 * 1024 ** 3);
    mockTasksFindFirst.mockResolvedValue(withCap('lots'));
    expect('warmSnapshotMaxBytes' in (await (await POST(req())).json())).toBe(false);
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

  it('security: the API key alone (what the container holds) is refused', async () => {
    expect((await POST(req({ dispatch: null }))).status).toBe(401);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('403 when the dispatch token does not match, or the webhook is disabled or tokenless', async () => {
    expect((await POST(req({ dispatch: 'wrong' }))).status).toBe(403);
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { webhookConfig: { url: 'u', token: DISPATCH, enabled: false } } }));
    expect((await POST(req())).status).toBe(403);
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { webhookConfig: { url: 'u', token: '', enabled: true } } }));
    expect((await POST(req({ dispatch: '' }))).status).toBe(401);
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { webhookConfig: null } }));
    expect((await POST(req())).status).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('400 for a missing or malformed taskId / workerId', async () => {
    expect((await POST(req({ body: {} }))).status).toBe(400);
    expect((await POST(req({ body: { taskId: '../x' } }))).status).toBe(400);
    expect((await POST(req({ body: { taskId: 'task-1', workerId: 5 } }))).status).toBe(400);
  });

  it('404 for an unknown task', async () => {
    mockTasksFindFirst.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(404);
  });

  it("404 for another team's workspace, even with its dispatch token", async () => {
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { teamId: 'team-2' } }));
    expect((await POST(req())).status).toBe(404);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('a restricted workspace of the own team needs a canClaim link', async () => {
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { accessMode: 'restricted' } }));
    expect((await POST(req())).status).toBe(404);
    mockGetPermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: false }]);
    expect((await POST(req())).status).toBe(404);
    mockGetPermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
    expect((await POST(req())).status).toBe(200);
  });

  it('a workspace-restricted token is refused outside its workspaces, even on its own team\'s open workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, scopes: ['workers:write'], workspaceIds: ['ws-other'] });
    mockGetPermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
    expect((await POST(req())).status).toBe(404);
    expect(mockMint).not.toHaveBeenCalled();
    mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, scopes: ['workers:write'], workspaceIds: ['ws-1'] });
    expect((await POST(req())).status).toBe(200);
  });

  it('a canClaim link grants a workspace outside the own team', async () => {
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { teamId: 'team-2' } }));
    mockGetPermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
    expect((await POST(req())).status).toBe(200);
  });

  describe('live worker requirement', () => {
    it('409 with no live worker', async () => {
      mockWorkersFindMany.mockResolvedValue([]);
      expect((await POST(req())).status).toBe(409);
    });

    it.each([
      ['claimed by another account', { accountId: 'account-2' }],
      ['finished', { status: 'completed' }],
      ['failed', { status: 'failed' }],
      ['on another task', { taskId: 'task-2' }],
      ['in another workspace', { workspaceId: 'ws-2' }],
    ])('409 when the only worker is %s', async (_label, o) => {
      mockWorkersFindMany.mockResolvedValue([liveWorker(o)]);
      expect((await POST(req())).status).toBe(409);
      expect(mockMint).not.toHaveBeenCalled();
    });

    it('workerId, when given, must be that live worker', async () => {
      expect((await POST(req({ body: { taskId: 'task-1', workerId: 'worker-9' } }))).status).toBe(409);
      expect((await POST(req({ body: { taskId: 'task-1', workerId: 'worker-1' } }))).status).toBe(200);
    });

    it.each(['idle', 'starting', 'running', 'waiting_input'])('accepts a %s worker', async (status) => {
      mockWorkersFindMany.mockResolvedValue([liveWorker({ status })]);
      expect((await POST(req())).status).toBe(200);
    });

    // A resuming container restores and fetches BEFORE it re-attaches, so the
    // grant must already work for the parked worker it names. A park keeps
    // the worker's status (a question's waiting_input, an orphan's running),
    // which is why no parked-specific rule is needed; this pins that.
    it.each(['waiting_input', 'running'])('grants the resume workerId of a worker parked in %s', async (status) => {
      mockWorkersFindMany.mockResolvedValue([liveWorker({ status, parkedUntil: new Date('2026-01-02T00:00:00Z') })]);
      expect((await POST(req({ body: { taskId: 'task-1', workerId: 'worker-1' } }))).status).toBe(200);
    });

    it('every parkable status is a live one', async () => {
      const { PARKABLE_WORKER_STATUSES, LIVE_WORKER_STATUSES } = await import('@buildd/shared');
      for (const s of PARKABLE_WORKER_STATUSES) expect(LIVE_WORKER_STATUSES as readonly string[]).toContain(s);
    });
  });

  it('409 when the workspace has no linked GitHub repo', async () => {
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { githubRepoId: null, githubRepo: null } }));
    expect((await POST(req())).status).toBe(409);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('409 when the installation is suspended', async () => {
    const row = taskRow();
    row.workspace.githubRepo.installation.suspendedAt = new Date() as any;
    mockTasksFindFirst.mockResolvedValue(row);
    expect((await POST(req())).status).toBe(409);
  });

  it('502 when GitHub refuses, without echoing any token', async () => {
    mockMint.mockImplementationOnce(() => Promise.reject(new Error('GitHub refused (HTTP 422)')));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('ghs_');
  });
});

describe('capability audit', () => {
  it('records an allowed grant with its expiry and repo, and no token', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const allowed = mockRecord.mock.calls.map(c => c[0]).find((r: any) => r.decision === 'allowed');
    expect(allowed).toMatchObject({ capability: 'github.repo_grant', principalVia: 'dispatch', workerId: 'worker-1', resource: 'github_repo:repo-row-1' });
    expect(JSON.stringify(mockRecord.mock.calls)).not.toContain('ghs_scoped_token');
  });

  it('records a refusal with its reason', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    await POST(req());
    expect(mockRecord.mock.calls.map(c => c[0])).toContainEqual(expect.objectContaining({ decision: 'refused', reasonCode: 'no_live_worker' }));
  });
});
