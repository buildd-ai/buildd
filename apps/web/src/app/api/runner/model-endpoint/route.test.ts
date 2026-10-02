/**
 * POST /api/runner/model-endpoint: the agent model endpoint for one cloud
 * task, for the dispatcher's egress handler (docs/design/agent-model-endpoint.md §3).
 * Same two-credential auth as /api/runner/github-token. Fixtures are
 * illustrative; nothing here is a real key.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock((_key: string | null, _req?: unknown) => Promise.resolve(null as any));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockWorkersFindMany = mock(() => Promise.resolve([] as any[]));
const mockGetPermissions = mock(() => Promise.resolve([] as any[]));
const mockResolveRoute = mock((_o: any) => Promise.resolve(null as any));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/account-workspace-cache', () => ({ getAccountWorkspacePermissions: mockGetPermissions }));
mock.module('@buildd/core/agent-endpoint', () => ({ resolveAgentModelRoute: mockResolveRoute }));
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

const ACCOUNT = { id: 'account-1', teamId: 'team-1', level: 'worker' };
const DISPATCH = 'dispatch-token-value';
const KEY = 'sk-agent-endpoint-example';

const ENDPOINT = {
  kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: KEY,
  authHeader: 'authorization', models: { 'claude-sonnet-5': 'team-sonnet' }, secretId: 'secret-1', scope: 'team',
};

function taskRow(overrides: { task?: Record<string, unknown>; workspace?: Record<string, unknown> } = {}) {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    backend: 'claude',
    ...overrides.task,
    workspace: {
      id: 'ws-1',
      teamId: 'team-1',
      accessMode: 'open',
      webhookConfig: { url: 'https://dispatcher.example/dispatch', token: DISPATCH, enabled: true },
      ...overrides.workspace,
    },
  };
}

const liveWorker = (o: Record<string, unknown> = {}) => ({
  id: 'worker-1', taskId: 'task-1', workspaceId: 'ws-1', accountId: 'account-1', status: 'running', ...o,
});

function req(opts: { apiKey?: string | null; dispatch?: string | null; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey !== null) headers.authorization = `Bearer ${opts.apiKey ?? 'bld_key'}`;
  if (opts.dispatch !== null) headers['x-buildd-dispatch-token'] = opts.dispatch ?? DISPATCH;
  return new NextRequest('http://localhost/api/runner/model-endpoint', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(opts.body ?? { taskId: 'task-1' }),
  });
}

beforeEach(() => {
  mockAuthenticateApiKey.mockReset();
  mockTasksFindFirst.mockReset();
  mockWorkersFindMany.mockReset();
  mockGetPermissions.mockReset();
  mockResolveRoute.mockReset();
  mockAuthenticateApiKey.mockImplementation((key: string | null) => Promise.resolve(key ? ACCOUNT : null));
  mockTasksFindFirst.mockResolvedValue(taskRow());
  mockWorkersFindMany.mockResolvedValue([liveWorker()]);
  mockGetPermissions.mockResolvedValue([]);
  mockResolveRoute.mockResolvedValue({ winner: 'endpoint', endpoint: ENDPOINT });
});

describe('POST /api/runner/model-endpoint', () => {
  it('returns the endpoint, no-store, ranked for this task, workspace and account', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      kind: 'anthropic-compatible',
      baseUrl: 'https://litellm.example.com',
      key: KEY,
      authHeader: 'authorization',
      models: { 'claude-sonnet-5': 'team-sonnet' },
    });
    expect(mockResolveRoute).toHaveBeenCalledWith({ teamId: 'team-1', workspaceId: 'ws-1', accountId: 'account-1' });
  });

  it('default no-op: no endpoint resolves ⇒ 404, so egress falls through to the Worker route', async () => {
    mockResolveRoute.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('404 when the endpoint loses the ranking (a workspace Anthropic key), never the Anthropic key', async () => {
    mockResolveRoute.mockResolvedValue({ winner: 'anthropic', endpoint: ENDPOINT, beatenBy: 'workspace' });
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
  });

  it('404 for a codex-backend task, without resolving anything', async () => {
    mockTasksFindFirst.mockResolvedValue(taskRow({ task: { backend: 'codex' } }));
    expect((await POST(req())).status).toBe(404);
    expect(mockResolveRoute).not.toHaveBeenCalled();
  });

  it('passes the request to auth, so a capability-scoped runner key is checked rather than refused', async () => {
    const r = req();
    expect((await POST(r)).status).toBe(200);
    expect(mockAuthenticateApiKey).toHaveBeenCalledWith('bld_key', r);
  });

  it('401 without an API key, 401 with a bad one', async () => {
    expect((await POST(req({ apiKey: null }))).status).toBe(401);
    mockAuthenticateApiKey.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(401);
    expect(mockResolveRoute).not.toHaveBeenCalled();
  });

  it('403 for a trigger token', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'trigger' });
    expect((await POST(req())).status).toBe(403);
    expect(mockResolveRoute).not.toHaveBeenCalled();
  });

  it('security: the API key alone (what the container holds) is refused', async () => {
    expect((await POST(req({ dispatch: null }))).status).toBe(401);
    expect(mockResolveRoute).not.toHaveBeenCalled();
  });

  it('403 when the dispatch token does not match', async () => {
    expect((await POST(req({ dispatch: 'wrong' }))).status).toBe(403);
    expect(mockResolveRoute).not.toHaveBeenCalled();
  });

  it('403 when the webhook is disabled, tokenless or absent', async () => {
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { webhookConfig: { url: 'u', token: DISPATCH, enabled: false } } }));
    expect((await POST(req())).status).toBe(403);
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { webhookConfig: { url: 'u', token: '', enabled: true } } }));
    expect((await POST(req({ dispatch: 'x' }))).status).toBe(403);
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { webhookConfig: null } }));
    expect((await POST(req())).status).toBe(403);
    expect(mockResolveRoute).not.toHaveBeenCalled();
  });

  it('400 for invalid JSON or a missing / malformed taskId / workerId', async () => {
    expect((await POST(req({ raw: '{not json' }))).status).toBe(400);
    expect((await POST(req({ body: {} }))).status).toBe(400);
    expect((await POST(req({ body: { taskId: '../x' } }))).status).toBe(400);
    expect((await POST(req({ body: { taskId: 'task-1', workerId: 5 } }))).status).toBe(400);
    expect(mockResolveRoute).not.toHaveBeenCalled();
  });

  it('404 for an unknown task', async () => {
    mockTasksFindFirst.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(404);
  });

  it("404 for another team's workspace, even with its dispatch token", async () => {
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { teamId: 'team-2' } }));
    expect((await POST(req())).status).toBe(404);
    expect(mockResolveRoute).not.toHaveBeenCalled();
  });

  it('a restricted workspace of the own team needs a canClaim link', async () => {
    mockTasksFindFirst.mockResolvedValue(taskRow({ workspace: { accessMode: 'restricted' } }));
    expect((await POST(req())).status).toBe(404);
    mockGetPermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: false }]);
    expect((await POST(req())).status).toBe(404);
    expect(mockResolveRoute).not.toHaveBeenCalled();
    mockGetPermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
    expect((await POST(req())).status).toBe(200);
  });

  describe('live worker requirement', () => {
    it('409 with no live worker', async () => {
      mockWorkersFindMany.mockResolvedValue([]);
      expect((await POST(req())).status).toBe(409);
      expect(mockResolveRoute).not.toHaveBeenCalled();
    });

    it.each([
      ['claimed by another account', { accountId: 'account-2' }],
      ['finished', { status: 'completed' }],
      ['on another task', { taskId: 'task-2' }],
      ['in another workspace', { workspaceId: 'ws-2' }],
    ])('409 when the only worker is %s', async (_label, o) => {
      mockWorkersFindMany.mockResolvedValue([liveWorker(o)]);
      expect((await POST(req())).status).toBe(409);
      expect(mockResolveRoute).not.toHaveBeenCalled();
    });

    it('workerId, when given, must be that live worker', async () => {
      expect((await POST(req({ body: { taskId: 'task-1', workerId: 'worker-9' } }))).status).toBe(409);
      expect((await POST(req({ body: { taskId: 'task-1', workerId: 'worker-1' } }))).status).toBe(200);
    });
  });

  it('500 on a resolver throw, without echoing any key', async () => {
    mockResolveRoute.mockImplementationOnce(() => Promise.reject(new Error(`boom ${KEY}`)));
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
  });
});
