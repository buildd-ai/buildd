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
const mockResolveAnthropicAuth = mock((_o: any) => Promise.resolve(null as any));
const mockTeamsFindFirst = mock((_o?: any) => Promise.resolve(null as any));
const mockResolveProvider = mock((_o: any) => Promise.resolve(null as any));
const mockRequester = mock((_t: any) => Promise.resolve(null as string | null));
const mockGateway = mock((_o: any, _f?: any) => Promise.resolve(null as any));

// Real pure pieces, taken before anything is mocked: the endpoint helpers and
// the resolver's own ranking, so the policy × requester table below runs the
// real policy and requester rules over fixture rows.
const realAgentEndpoint = { ...(await import('@buildd/core/agent-endpoint')) };
const realResolve = { ...(await import('@buildd/core/providers/resolve')) };
const realProviders = { ...(await import('@buildd/core/providers')) };

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/account-workspace-cache', () => ({ getAccountWorkspacePermissions: mockGetPermissions }));
mock.module('@buildd/core/agent-endpoint', () => ({ ...realAgentEndpoint, resolveAgentModelRoute: mockResolveRoute, resolveAgentEndpoint: mockGateway }));
mock.module('@/lib/claude-credential', () => ({
  resolveAnthropicAuth: mockResolveAnthropicAuth,
  isAnthropicApiKeyAuth: (a: { purpose: string }) => a.purpose === 'inference_key' || a.purpose === 'anthropic_api_key',
}));
mock.module('@buildd/core/providers/resolve', () => ({ ...realResolve, resolveProviderCredential: mockResolveProvider }));
mock.module('@buildd/core/task-requester', () => ({ resolveTaskRequesterUserId: mockRequester }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findMany: mockWorkersFindMany },
      teams: { findFirst: mockTeamsFindFirst },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  teams: { id: 'id' },
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
const ANTHROPIC_KEY = 'sk-ant-team-key-example';

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
  mockResolveAnthropicAuth.mockReset();
  mockAuthenticateApiKey.mockImplementation((key: string | null) => Promise.resolve(key ? ACCOUNT : null));
  mockTasksFindFirst.mockResolvedValue(taskRow());
  mockWorkersFindMany.mockResolvedValue([liveWorker()]);
  mockGetPermissions.mockResolvedValue([]);
  mockResolveRoute.mockResolvedValue({ winner: 'endpoint', endpoint: ENDPOINT });
  mockResolveAnthropicAuth.mockResolvedValue(null);
  mockTeamsFindFirst.mockReset();
  mockResolveProvider.mockReset();
  mockRequester.mockReset();
  mockGateway.mockReset();
  // Default: a team that has never set credential_policy.
  mockTeamsFindFirst.mockResolvedValue({ credentialPolicy: null, inferenceKeyPolicy: null });
  mockResolveProvider.mockImplementation((input: any) => Promise.resolve(selectFrom(ROWS, input)));
  mockRequester.mockResolvedValue(null);
  mockGateway.mockResolvedValue(null);
});

// ── Fixtures for the policy path ─────────────────────────────────────────────

const REQUESTER = 'user-requester';
const OTHER_USER = 'user-other';

function row(o: Partial<{ id: string; purpose: string; label: string | null; value: string; workspaceId: string | null; accountId: string | null; userId: string | null }>) {
  return {
    id: o.id ?? 'row',
    purpose: o.purpose ?? 'inference_key',
    label: o.label === undefined ? 'anthropic' : o.label,
    // The fixture "decrypt" below is the identity, so the value is stored as-is.
    encryptedValue: o.value ?? 'sk-ant-fixture',
    accountId: o.accountId ?? null,
    workspaceId: o.workspaceId ?? null,
    userId: o.userId ?? null,
    healthStatus: null,
    tokenExpiresAt: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

const TEAM_KEY = row({ id: 'team-key', value: 'sk-ant-team-fixture' });
const MY_KEY = row({ id: 'my-key', value: 'sk-ant-mine-fixture', userId: REQUESTER });
const THEIR_KEY = row({ id: 'their-key', value: 'sk-ant-theirs-fixture', userId: OTHER_USER });
let ROWS: ReturnType<typeof row>[] = [TEAM_KEY, MY_KEY, THEIR_KEY];

/**
 * resolveProviderCredential without the database: the real ranking, policy and
 * requester rules (selectProviderCredential) over fixture rows, with the
 * eligibility and policy the real resolver derives from its input.
 */
function selectFrom(rows: ReturnType<typeof row>[], input: any) {
  return realResolve.selectProviderCredential(rows, {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    requesterUserId: input.requesterUserId,
    surface: input.surface,
    eligible: realResolve.eligibleProviders(input.surface).eligible,
    policy: realProviders.surfacePolicy(input.team, input.surface),
  }, (v: string) => v);
}

function withPolicy(credentialPolicy: string | null, inferenceKeyPolicy: string | null = null) {
  mockTeamsFindFirst.mockResolvedValue({ credentialPolicy, inferenceKeyPolicy });
}

describe('credential_policy NULL: exactly the egress decision this route always made', () => {
  it('never asks the provider resolver; the legacy ranking and Anthropic lookup run as before', async () => {
    mockResolveRoute.mockResolvedValue({ winner: 'anthropic', endpoint: ENDPOINT, beatenBy: 'workspace' });
    mockResolveAnthropicAuth.mockResolvedValue({ headers: { 'x-api-key': ANTHROPIC_KEY }, purpose: 'anthropic_api_key', secretId: 'secret-2' });
    mockRequester.mockResolvedValue(REQUESTER);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: 'anthropic_api_key', key: ANTHROPIC_KEY });
    expect(mockResolveRoute).toHaveBeenCalledWith({ teamId: 'team-1', workspaceId: 'ws-1', accountId: 'account-1' });
    expect(mockResolveAnthropicAuth).toHaveBeenCalledWith({ teamId: 'team-1', workspaceId: 'ws-1' });
    expect(mockResolveProvider).not.toHaveBeenCalled();
    // A personal key is never in play, so the requester is not even looked up.
    expect(mockRequester).not.toHaveBeenCalled();
  });

  // Provider parity: the team key in canonical storage (`inference_key` /
  // `anthropic`) reaches cloud egress exactly as the legacy row does.
  it('a canonical team Anthropic key reaches egress with the same wire answer as the legacy one', async () => {
    mockResolveRoute.mockResolvedValue(null);
    mockResolveAnthropicAuth.mockResolvedValue({ headers: { 'x-api-key': ANTHROPIC_KEY }, purpose: 'inference_key', secretId: 'secret-3' });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: 'anthropic_api_key', key: ANTHROPIC_KEY });
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });

  it.each([
    ['the endpoint wins', { winner: 'endpoint', endpoint: ENDPOINT }, null, 200],
    ['no endpoint, no key', null, null, 404],
    ['a seat wins', { winner: 'anthropic', endpoint: ENDPOINT, beatenBy: 'workspace' }, { headers: {}, purpose: 'oauth_token', secretId: 's' }, 404],
  ] as const)('%s ⇒ the legacy answer', async (_l, route, auth, status) => {
    mockResolveRoute.mockResolvedValue(route as any);
    mockResolveAnthropicAuth.mockResolvedValue(auth as any);
    expect((await POST(req())).status).toBe(status);
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });

  it('the chat-only inference_key_policy does not opt agent egress in', async () => {
    withPolicy(null, 'own');
    await POST(req());
    expect(mockResolveProvider).not.toHaveBeenCalled();
    expect(mockResolveRoute).toHaveBeenCalled();
  });

  it('an unreadable team row reads as unset: the legacy path, not a refusal', async () => {
    mockTeamsFindFirst.mockImplementation(() => Promise.reject(new Error('db down')));
    expect((await POST(req())).status).toBe(200);
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });
});

describe('credential_policy set: the provider resolver decides, for this task’s requester', () => {
  it('asks resolveProviderCredential on the cloud-egress surface with the requester and the team row', async () => {
    withPolicy('personal_first');
    mockRequester.mockResolvedValue(REQUESTER);
    await POST(req());
    expect(mockResolveProvider).toHaveBeenCalledWith({
      teamId: 'team-1',
      workspaceId: 'ws-1',
      accountId: 'account-1',
      requesterUserId: REQUESTER,
      surface: 'cloud-egress',
      team: { credentialPolicy: 'personal_first', inferenceKeyPolicy: null },
    });
    expect(mockRequester).toHaveBeenCalledTimes(1);
    expect(mockResolveRoute).not.toHaveBeenCalled();
    expect(mockResolveAnthropicAuth).not.toHaveBeenCalled();
  });

  // policy × requester, over a team key, the requester's own key and someone else's.
  it.each([
    ['team', REQUESTER, 200, 'sk-ant-team-fixture'],
    ['team', null, 200, 'sk-ant-team-fixture'],
    ['personal_first', REQUESTER, 200, 'sk-ant-mine-fixture'],
    ['personal_first', null, 200, 'sk-ant-team-fixture'],
    ['personal_first', 'user-stranger', 200, 'sk-ant-team-fixture'],
    ['personal_only', REQUESTER, 200, 'sk-ant-mine-fixture'],
    ['personal_only', null, 404, 'no_personal_credential'],
    ['personal_only', 'user-stranger', 404, 'no_personal_credential'],
  ] as const)('policy=%s requester=%s ⇒ %d %s', async (policy, requester, status, want) => {
    withPolicy(policy);
    mockRequester.mockResolvedValue(requester);
    const res = await POST(req());
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    if (status === 200) {
      expect(body).toEqual({ source: 'anthropic_api_key', key: want });
    } else {
      expect(body.reason).toBe(want);
    }
    // Someone else's personal key never leaves, whatever the policy.
    expect(JSON.stringify(body)).not.toContain('sk-ant-theirs-fixture');
  });

  it('the canonical Anthropic key keeps the anthropic_api_key flag (its precedence over MODEL_PROXY_URL), as the legacy purpose does', async () => {
    withPolicy('team');
    ROWS = [row({ id: 'legacy', purpose: 'anthropic_api_key', label: null, value: 'sk-ant-legacy-fixture' })];
    try {
      expect(await (await POST(req())).json()).toEqual({ source: 'anthropic_api_key', key: 'sk-ant-legacy-fixture' });
      ROWS = [row({ id: 'canonical', value: 'sk-ant-canonical-fixture' })];
      expect(await (await POST(req())).json()).toEqual({ source: 'anthropic_api_key', key: 'sk-ant-canonical-fixture' });
    } finally {
      ROWS = [TEAM_KEY, MY_KEY, THEIR_KEY];
    }
  });

  it('a seat never wins on cloud egress: a seat alone ⇒ 404 no_credential', async () => {
    withPolicy('team');
    ROWS = [
      row({ id: 'seat', purpose: 'oauth_token', label: null, value: 'seat-token-fixture', workspaceId: 'ws-1' }),
    ];
    try {
      const res = await POST(req());
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.reason).toBe('no_credential');
      expect(JSON.stringify(body)).not.toContain('seat-token-fixture');
    } finally {
      ROWS = [TEAM_KEY, MY_KEY, THEIR_KEY];
    }
  });

  it('an anthropic-compatible agent_endpoint at workspace scope beats the team key and is served as an endpoint', async () => {
    withPolicy('team');
    const blob = { kind: 'anthropic-compatible', baseUrl: 'https://proxy.example.com', apiKey: KEY, authHeader: 'x-api-key', models: { 'claude-sonnet-5': 'team-sonnet' } };
    ROWS = [TEAM_KEY, row({ id: 'endpoint', purpose: 'agent_endpoint', label: null, value: JSON.stringify(blob), workspaceId: 'ws-1' })];
    try {
      expect(await (await POST(req())).json()).toEqual({
        kind: 'anthropic-compatible', baseUrl: 'https://proxy.example.com', key: KEY, authHeader: 'x-api-key', models: { 'claude-sonnet-5': 'team-sonnet' },
      });
    } finally {
      ROWS = [TEAM_KEY, MY_KEY, THEIR_KEY];
    }
  });

  it('a gateway reference is served through resolveAgentEndpoint, only when it lands on the same row', async () => {
    withPolicy('team');
    ROWS = [row({ id: 'gw-ref', purpose: 'agent_endpoint', label: null, value: JSON.stringify({ kind: 'gateway' }) })];
    const gatewayRoute = {
      kind: 'gateway', baseUrl: 'https://gateway.example.com', apiKey: 'sk-gateway-fixture', authHeader: 'authorization',
      models: {}, toolSearch: false, secretId: 'gw-ref', scope: 'team',
    };
    mockGateway.mockResolvedValue(gatewayRoute);
    try {
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        kind: 'gateway', baseUrl: 'https://gateway.example.com', key: 'sk-gateway-fixture', authHeader: 'authorization', models: {},
      });
      expect(mockGateway).toHaveBeenCalledWith({ teamId: 'team-1', workspaceId: 'ws-1' });

      // A different endpoint row is never substituted for the resolver's winner.
      mockGateway.mockResolvedValue({ ...gatewayRoute, secretId: 'some-other-row' });
      expect((await POST(req())).status).toBe(404);
      // No gateway behind the reference ⇒ nothing to serve.
      mockGateway.mockResolvedValue(null);
      expect((await POST(req())).status).toBe(404);
    } finally {
      ROWS = [TEAM_KEY, MY_KEY, THEIR_KEY];
    }
  });

  it('an OpenRouter endpoint reference is served through resolveAgentEndpoint with the stored key, same row only', async () => {
    withPolicy('team');
    const ref = { kind: 'openrouter', baseUrl: realAgentEndpoint.OPENROUTER_AGENT_BASE_URL, authHeader: 'authorization' };
    ROWS = [
      row({ id: 'or-key', label: 'openrouter', value: 'sk-or-stored-fixture' }),
      row({ id: 'or-ref', purpose: 'agent_endpoint', label: null, value: JSON.stringify(ref) }),
    ];
    const resolved = {
      kind: 'openrouter', baseUrl: realAgentEndpoint.OPENROUTER_AGENT_BASE_URL, apiKey: 'sk-or-stored-fixture', authHeader: 'authorization',
      models: {}, toolSearch: true, secretId: 'or-ref', scope: 'team',
    };
    mockGateway.mockResolvedValue(resolved);
    try {
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        kind: 'openrouter', baseUrl: realAgentEndpoint.OPENROUTER_AGENT_BASE_URL, key: 'sk-or-stored-fixture', authHeader: 'authorization', models: {},
      });
      expect(mockGateway).toHaveBeenCalledWith({ teamId: 'team-1', workspaceId: 'ws-1' });
      // Another row is never substituted for the resolver's winner.
      mockGateway.mockResolvedValue({ ...resolved, secretId: 'some-other-row' });
      expect((await POST(req())).status).toBe(404);
      // Nothing stored behind the reference ⇒ nothing to serve.
      mockGateway.mockResolvedValue(null);
      expect((await POST(req())).status).toBe(404);
    } finally {
      ROWS = [TEAM_KEY, MY_KEY, THEIR_KEY];
    }
  });

  it('a Cloudflare reference is served with its upstream and gateway header, same row only', async () => {
    withPolicy('team');
    ROWS = [row({ id: 'cf-ref', purpose: 'agent_endpoint', label: null, value: JSON.stringify({ kind: 'cloudflare', upstream: 'anthropic' }) })];
    const resolved = {
      kind: 'cloudflare', upstream: 'anthropic', baseUrl: 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/buildd/anthropic',
      apiKey: 'sk-ant-stored-fixture', authHeader: 'x-api-key', models: {}, toolSearch: true,
      headers: { 'cf-aig-authorization': 'Bearer gw-run-fixture' }, secretId: 'cf-ref', scope: 'team',
    };
    mockGateway.mockResolvedValue(resolved);
    try {
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        kind: 'cloudflare', upstream: 'anthropic', baseUrl: resolved.baseUrl, key: 'sk-ant-stored-fixture', authHeader: 'x-api-key', models: {},
        headers: { 'cf-aig-authorization': 'Bearer gw-run-fixture' },
      });
      mockGateway.mockResolvedValue({ ...resolved, secretId: 'some-other-row' });
      expect((await POST(req())).status).toBe(404);
    } finally {
      ROWS = [TEAM_KEY, MY_KEY, THEIR_KEY];
    }
  });

  it('an OpenRouter key is served on OpenRouter’s Anthropic-compatible root', async () => {
    withPolicy('team');
    ROWS = [row({ id: 'or', label: 'openrouter', value: 'sk-or-fixture' })];
    try {
      expect(await (await POST(req())).json()).toEqual({
        kind: 'openrouter', baseUrl: realAgentEndpoint.OPENROUTER_AGENT_BASE_URL, key: 'sk-or-fixture', authHeader: 'authorization', models: {},
      });
    } finally {
      ROWS = [TEAM_KEY, MY_KEY, THEIR_KEY];
    }
  });

  it('a failed requester walk is team work: personal_first falls back to the team key, never a personal one', async () => {
    withPolicy('personal_first');
    mockRequester.mockImplementation(() => Promise.reject(new Error('walk failed')));
    expect(await (await POST(req())).json()).toEqual({ source: 'anthropic_api_key', key: 'sk-ant-team-fixture' });
  });

  it('a codex task is still 404 before any lookup', async () => {
    withPolicy('team');
    mockTasksFindFirst.mockResolvedValue(taskRow({ task: { backend: 'codex' } }));
    expect((await POST(req())).status).toBe(404);
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });

  it('500 on a resolver throw, without echoing any key', async () => {
    withPolicy('team');
    mockResolveProvider.mockImplementationOnce(() => Promise.reject(new Error(`boom ${KEY}`)));
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
  });
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

  it('default no-op: no endpoint and no Anthropic key resolves ⇒ 404, so egress falls through to the Worker route', async () => {
    mockResolveRoute.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it("the endpoint loses the ranking to the task's own Anthropic API key ⇒ that key, flagged for egress precedence", async () => {
    mockResolveRoute.mockResolvedValue({ winner: 'anthropic', endpoint: ENDPOINT, beatenBy: 'workspace' });
    mockResolveAnthropicAuth.mockResolvedValue({ headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }, purpose: 'anthropic_api_key', secretId: 'secret-2' });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ source: 'anthropic_api_key', key: ANTHROPIC_KEY });
    expect(mockResolveAnthropicAuth).toHaveBeenCalledWith({ teamId: 'team-1', workspaceId: 'ws-1' });
  });

  it('no agent_endpoint at all, but the task has its own Anthropic API key ⇒ that key', async () => {
    mockResolveRoute.mockResolvedValue(null);
    mockResolveAnthropicAuth.mockResolvedValue({ headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }, purpose: 'anthropic_api_key', secretId: 'secret-2' });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: 'anthropic_api_key', key: ANTHROPIC_KEY });
  });

  it('404 when an OAuth seat or Claude credential wins instead — cloud egress never carries a seat token', async () => {
    mockResolveRoute.mockResolvedValue({ winner: 'anthropic', endpoint: ENDPOINT, beatenBy: 'workspace' });
    mockResolveAnthropicAuth.mockResolvedValue({ headers: { Authorization: `Bearer ${KEY}` }, purpose: 'oauth_token', secretId: 'secret-3' });
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);

    mockResolveAnthropicAuth.mockResolvedValue({ headers: { Authorization: `Bearer ${KEY}` }, purpose: 'claude_credential', secretId: 'secret-4' });
    expect((await POST(req())).status).toBe(404);
  });

  it('404 when the endpoint loses the ranking and no Anthropic key resolves either, never the agent_endpoint key', async () => {
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
