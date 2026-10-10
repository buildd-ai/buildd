import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PROVIDER_REGISTRY, providerDescriptor } from '@buildd/core/providers';

// ── Fixture credentials: none of these may appear in any response body ──────
const V = {
  teamAnthropic: 'sk-ant-api03-FIXTURE-team-anthropic-value-1111',
  wsAnthropic: 'sk-ant-api03-FIXTURE-ws-anthropic-value-2222',
  mineAnthropic: 'sk-ant-api03-FIXTURE-member-own-value-3333',
  otherAnthropic: 'sk-ant-api03-FIXTURE-other-member-value-4444',
  teamSeat: 'sk-ant-oat01-FIXTURE-team-seat-value-5555',
  gatewayKey: 'sk-FIXTURE-gateway-key-value-6666',
  newKey: 'sk-ant-api03-FIXTURE-newly-pasted-value-7777',
  newToken: 'sk-ant-oat01-FIXTURE-newly-pasted-token-8888',
  newOpenRouter: 'sk-or-v1-FIXTURE-newly-pasted-or-value-9999',
};
const FIXTURES = Object.values(V);
const bodies: string[] = [];

// ── Rows ─────────────────────────────────────────────────────────────────────
type Row = Record<string, any>;
let rows: Row[] = [];
let nextId = 1;
const row = (r: Partial<Row>): Row => ({
  id: `sec-${nextId++}`, teamId: 't-1', label: null, accountId: null, workspaceId: null, userId: null,
  healthStatus: 'healthy', lastVerifiedAt: null, lastVerificationError: null, updatedAt: new Date('2026-10-01T00:00:00Z'), ...r,
});
const enc = (v: string) => `enc:${v}`;

function seed() {
  nextId = 1;
  rows = [
    row({ purpose: 'anthropic_api_key', encryptedValue: enc(V.teamAnthropic) }),
    row({ purpose: 'anthropic_api_key', workspaceId: 'ws-1', encryptedValue: enc(V.wsAnthropic) }),
    row({ purpose: 'inference_key', label: 'anthropic', userId: 'u-member', encryptedValue: enc(V.mineAnthropic) }),
    row({ purpose: 'inference_key', label: 'anthropic', userId: 'u-other', encryptedValue: enc(V.otherAnthropic) }),
    row({ purpose: 'oauth_token', encryptedValue: enc(V.teamSeat) }),
    row({ purpose: 'inference_key', label: 'litellm', encryptedValue: enc(JSON.stringify({ baseUrl: 'https://gw.example.com/v1', apiKey: V.gatewayKey })) }),
    row({ purpose: 'mcp_credential', label: 'NOT_A_MODEL_KEY', encryptedValue: enc('mcp-value-not-listed') }),
    row({ purpose: 'anthropic_api_key', teamId: 't-2', encryptedValue: enc('sk-ant-api03-another-team') }),
  ];
}

let team: Row | null = { credentialPolicy: null, inferenceKeyPolicy: null };
let workspaceExists = true;
const updates: Array<Record<string, unknown>> = [];
let deleteReturns: Array<{ id: string }> = [];
const deleteCalls: number[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      secrets: { findMany: async () => rows.map(r => ({ ...r })) },
      teams: { findFirst: async () => team },
      workspaces: { findFirst: async () => (workspaceExists ? { id: 'ws-1' } : undefined) },
    },
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updates.push(v); } }) }),
    delete: () => ({ where: () => ({ returning: async () => { deleteCalls.push(1); return deleteReturns; } }) }),
  },
}));

const replaceScoped = mock(async (value: string, meta: Record<string, any>) => {
  const r = row({ purpose: meta.purpose, label: meta.label ?? null, workspaceId: meta.workspaceId ?? null, accountId: meta.accountId ?? null, userId: meta.userId ?? null, encryptedValue: enc(value) });
  rows.push(r);
  return r.id;
});
mock.module('@buildd/core/secrets', () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ''),
  getSecretsProvider: () => ({ replaceScoped }),
}));
mock.module('@buildd/core/inference-keys', () => ({
  maskKeyLast4: (v: string) => (v.trim().length >= 8 ? v.trim().slice(-4) : ''),
  verifyProviderKey: async () => ({ health: 'healthy', error: null }),
}));

const setProviderKey = mock(async (input: any) => {
  rows.push(row({ purpose: 'inference_key', label: input.provider, userId: input.scope === 'user' ? input.userId : null, encryptedValue: enc(input.value) }));
  return { ok: true, key: { id: 'x' } };
});
const deleteProviderKey = mock(async () => true);
mock.module('@/lib/provider-keys', () => ({
  setProviderKey, deleteProviderKey, providerKeyProblem: () => null,
}));
const setTeamGateway = mock(async () => ({ ok: true, gateway: {} }));
const deleteTeamGateway = mock(async () => true);
mock.module('@/lib/litellm-gateway-settings', () => ({ setTeamGateway, deleteTeamGateway }));
const setTeamAgentEndpoint = mock(async () => ({ ok: true, endpoint: {} }));
const deleteTeamAgentEndpoint = mock(async () => true);
mock.module('@/lib/agent-endpoint-settings', () => ({ setTeamAgentEndpoint, deleteTeamAgentEndpoint }));
const requeue = mock(async () => ({ requeued: [] as string[] }));
mock.module('@/lib/credential-recovery', () => ({ requeueAuthFailedTasks: requeue }));

// ── Callers ──────────────────────────────────────────────────────────────────
let sessionUser: { id: string } | null = null;
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => sessionUser }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['t-1'],
  resolveActiveTeamId: async () => 't-1',
}));
const ADMINS = new Set(['u-admin']);
mock.module('@/lib/permissions', () => ({
  can: async (caller: any, _p: string, teamId: string) =>
    teamId === 't-1' && (caller.kind === 'user' ? ADMINS.has(caller.userId) : caller.level === 'admin'),
}));
const ACCOUNTS: Record<string, Row> = {
  bld_admin: { id: 'acc-admin', teamId: 't-1', level: 'admin' },
  bld_worker: { id: 'acc-worker', teamId: 't-1', level: 'worker' },
  oauth_member: { id: 'acc-session', teamId: 't-1', level: 'worker', sessionUserId: 'u-member' },
  oauth_admin: { id: 'acc-session', teamId: 't-1', level: 'admin', sessionUserId: 'u-admin' },
  bldt_task: { id: 'acc-admin', teamId: 't-1', level: 'worker', taskScope: { taskId: 'task-1', workspaceId: 'ws-1', expiresAt: 0 } },
};
mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: async (token: string) => ACCOUNTS[token] ?? null,
  taskScopeAllowsWorkspace: (account: { taskScope?: { workspaceId: string } }, ws: string | null | undefined) =>
    !account.taskScope || (!!ws && ws === account.taskScope.workspaceId),
}));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: (a: Row) => a.level === 'admin' }));

const { GET, PUT, DELETE, PATCH } = await import('./route');

function req(method: string, url: string, opts: { body?: unknown; bearer?: string } = {}) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}
async function call(res: Response): Promise<{ status: number; body: any }> {
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const asAdmin = () => { sessionUser = { id: 'u-admin' }; };
const asMember = () => { sessionUser = { id: 'u-member' }; };

beforeEach(() => {
  seed();
  team = { credentialPolicy: null, inferenceKeyPolicy: null };
  workspaceExists = true;
  sessionUser = null;
  updates.length = 0;
  deleteCalls.length = 0;
  deleteReturns = [];
  for (const m of [replaceScoped, setProviderKey, deleteProviderKey, setTeamGateway, deleteTeamGateway, setTeamAgentEndpoint, deleteTeamAgentEndpoint, requeue]) m.mockClear();
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe('GET /api/providers', () => {
  it('401s with no session and no bearer', async () => {
    expect((await call(await GET(req('GET', '/api/providers')))).status).toBe(401);
  });

  it('lists every registry provider in settings order, with surfaces verbatim from the registry', async () => {
    asMember();
    const { status, body } = await call(await GET(req('GET', '/api/providers')));
    expect(status).toBe(200);
    expect(body.providers.map((p: any) => p.id)).toEqual(
      [...PROVIDER_REGISTRY].sort((a, b) => a.settingsCard.order - b.settingsCard.order).map(p => p.id));
    const openai = body.providers.find((p: any) => p.id === 'openai');
    expect(openai.surfaces['agent-claude']).toEqual(providerDescriptor('openai').surfaces['agent-claude']);
    expect(body.providers.find((p: any) => p.id === 'litellm').scopes.mine.ok).toBe(false);
  });

  it('shows team rows to a member, their own personal row, and never another member’s', async () => {
    asMember();
    const { body } = await call(await GET(req('GET', '/api/providers')));
    const anthropic = body.providers.find((p: any) => p.id === 'anthropic');
    expect(anthropic.set.team).toHaveLength(1);
    expect(anthropic.set.team[0]).toMatchObject({ purpose: 'anthropic_api_key', legacy: true, last4: '1111', scope: 'team' });
    expect(anthropic.set.team[0].servesToday).toEqual(['chat', 'agent-claude', 'cloud-egress']);
    expect(anthropic.set.mine).toHaveLength(1);
    expect(anthropic.set.mine[0]).toMatchObject({ last4: '3333', scope: 'mine', legacy: false });
    expect(JSON.stringify(body)).not.toContain('4444');
    expect(anthropic.set.workspace).toBeNull();
    expect(body.caller).toMatchObject({ principal: 'person', canSetMine: true });
    expect(body.caller.can.manage_team_credentials).toBe(false);
    // Not a model credential, another team: never listed.
    expect(JSON.stringify(body)).not.toContain('NOT_A_MODEL_KEY');
    expect(JSON.stringify(body)).not.toContain('another-team');
  });

  it('counts personal model keys across the team (never whose), for showing "Who pays"', async () => {
    asMember();
    const { body } = await call(await GET(req('GET', '/api/providers')));
    // u-member's and u-other's personal Anthropic keys; the other team's row and the MCP secret don't count.
    expect(body.personalKeyCount).toBe(2);
    expect(JSON.stringify(body)).not.toContain('u-other');
  });

  it('lists a workspace’s own rows when asked, and summarises a gateway by its key’s last four', async () => {
    asAdmin();
    const { body } = await call(await GET(req('GET', '/api/providers?workspaceId=ws-1')));
    const anthropic = body.providers.find((p: any) => p.id === 'anthropic');
    expect(anthropic.set.workspace).toHaveLength(1);
    expect(anthropic.set.workspace[0].last4).toBe('2222');
    expect(body.providers.find((p: any) => p.id === 'litellm').set.team[0].last4).toBe('6666');
    expect(body.providers.find((p: any) => p.id === 'claude-subscription').set.team[0]).toMatchObject({ shape: 'setup_token', last4: '5555' });
    expect(body.caller.can).toEqual({ manage_team_model_keys: true, manage_team_credentials: true, manage_inference_providers: true, manage_team_settings: true });
  });

  it('reports the team credential policy for chat and agents', async () => {
    asMember();
    team = { credentialPolicy: 'personal_first', inferenceKeyPolicy: 'team_or_own' };
    const { body } = await call(await GET(req('GET', '/api/providers')));
    expect(body.policy).toEqual({
      credentialPolicy: 'personal_first',
      chat: { policy: 'personal_first', source: 'credential_policy' },
      agent: { policy: 'personal_first', enforced: true, source: 'credential_policy' },
    });
  });

  it('an API key sees team rows only (no person, no mine)', async () => {
    const { body } = await call(await GET(req('GET', '/api/providers', { bearer: 'bld_worker' })));
    expect(body.caller).toMatchObject({ principal: 'key', canSetMine: false });
    for (const p of body.providers) expect(p.set.mine).toBeNull();
  });

  it('an OAuth MCP session is its person', async () => {
    const { body } = await call(await GET(req('GET', '/api/providers', { bearer: 'oauth_member' })));
    expect(body.caller.principal).toBe('person');
    expect(body.providers.find((p: any) => p.id === 'anthropic').set.mine[0].last4).toBe('3333');
  });

  it('a task token reads its own workspace only', async () => {
    const own = await call(await GET(req('GET', '/api/providers', { bearer: 'bldt_task' })));
    expect(own.status).toBe(200);
    expect(own.body.workspaceId).toBe('ws-1');
    expect(own.body.caller.principal).toBe('task_token');
    const other = await call(await GET(req('GET', '/api/providers?workspaceId=ws-other', { bearer: 'bldt_task' })));
    expect(other.status).toBe(404);
  });

  it('a bearer cannot reach another team', async () => {
    expect((await call(await GET(req('GET', '/api/providers?teamId=t-2', { bearer: 'bld_admin' })))).status).toBe(404);
  });
});

// ── PUT ──────────────────────────────────────────────────────────────────────

describe('PUT /api/providers', () => {
  // Provider parity: agent runs read the canonical storage, so a team Anthropic
  // key is the team chat key (`inference_key` / `anthropic`), written by the
  // chat key function, and it serves chat and agent runs alike. (It used to go
  // to the legacy `anthropic_api_key`, the only storage the host claim read.)
  it('a team Anthropic key is stored once, in canonical storage, and serves chat and agent runs', async () => {
    asAdmin();
    const { status, body } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'anthropic', scope: 'team', value: V.newKey } })));
    expect(status).toBe(200);
    expect(setProviderKey).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic', scope: 'team', teamId: 't-1' }));
    expect(replaceScoped).not.toHaveBeenCalled();
    const stored = body.credentials.find((c: any) => c.last4 === '7777');
    expect(stored).toMatchObject({ purpose: 'inference_key', label: 'anthropic', legacy: false, scope: 'team', accountScoped: false });
    expect(stored.servesToday).toEqual(['chat', 'agent-claude', 'cloud-egress']);
    // An agent credential: tasks that failed on the old key go back in the queue.
    expect(body.requeued).toBe(0);
    expect(requeue).toHaveBeenCalledTimes(1);
  });

  it('a workspace Anthropic key is stored in canonical storage at that workspace, never account-scoped', async () => {
    asAdmin();
    const { status, body } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'anthropic', scope: 'workspace', workspaceId: 'ws-1', value: V.newKey } })));
    expect(status).toBe(200);
    const [, meta] = replaceScoped.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(meta).toMatchObject({ teamId: 't-1', purpose: 'inference_key', label: 'anthropic', workspaceId: 'ws-1' });
    expect(meta.accountId).toBeUndefined();
    expect(body.credentials.find((c: any) => c.last4 === '7777').servesToday).toEqual(['chat', 'agent-claude', 'cloud-egress']);
    expect(requeue).toHaveBeenCalledTimes(1);
  });

  it('a team OpenAI key is stored in canonical storage and serves chat and Codex runs', async () => {
    asAdmin();
    const value = 'sk-proj-FIXTURE-team-openai-value-0000';
    FIXTURES.push(value);
    const { status, body } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'openai', scope: 'team', value } })));
    expect(status).toBe(200);
    expect(setProviderKey).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', scope: 'team' }));
    const stored = body.credentials.find((c: any) => c.last4 === '0000');
    expect(stored).toMatchObject({ purpose: 'inference_key', label: 'openai', legacy: false });
    expect(stored.servesToday).toEqual(['chat', 'agent-codex']);
  });

  it('a team Anthropic key needs both the model-key and the agent-credential permission', async () => {
    asAdmin();
    const may: string[] = [];
    const { can } = await import('@/lib/permissions');
    const spy = mock(async (caller: any, p: string, teamId: string) => { may.push(p); return can(caller, p as never, teamId); });
    mock.module('@/lib/permissions', () => ({ can: spy }));
    try {
      expect((await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'anthropic', scope: 'team', value: V.newKey } })))).status).toBe(200);
    } finally {
      mock.module('@/lib/permissions', () => ({ can }));
    }
    expect(may).toEqual(expect.arrayContaining(['manage_team_model_keys', 'manage_team_credentials']));
  });

  it('a team OpenRouter key is the chat key, written by the chat key function', async () => {
    asAdmin();
    const { status } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'openrouter', scope: 'team', value: V.newOpenRouter } })));
    expect(status).toBe(200);
    expect(setProviderKey).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openrouter', scope: 'team' }));
    expect(replaceScoped).not.toHaveBeenCalled();
  });

  it('a member cannot set a team key', async () => {
    asMember();
    const { status } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'anthropic', scope: 'team', value: V.newKey } })));
    expect(status).toBe(403);
    expect(replaceScoped).not.toHaveBeenCalled();
  });

  it('a member sets their own key (mine) through the personal key function', async () => {
    asMember();
    const { status, body } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'anthropic', scope: 'mine', value: V.newKey } })));
    expect(status).toBe(200);
    expect(setProviderKey).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic', scope: 'user', userId: 'u-member' }));
    expect(body.credentials.every((c: any) => c.scope === 'mine')).toBe(true);
  });

  it('an OAuth person session sets mine at worker level', async () => {
    const { status } = await call(await PUT(req('PUT', '/api/providers', { bearer: 'oauth_member', body: { provider: 'openai', scope: 'mine', value: 'sk-proj-FIXTURE-oauth-own' } })));
    FIXTURES.push('sk-proj-FIXTURE-oauth-own');
    expect(status).toBe(200);
    expect(setProviderKey).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', scope: 'user', userId: 'u-member' }));
  });

  it('a key or a task token cannot write mine', async () => {
    const key = await call(await PUT(req('PUT', '/api/providers', { bearer: 'bld_admin', body: { provider: 'anthropic', scope: 'mine', value: V.newKey } })));
    expect(key.status).toBe(403);
    expect(key.body.error).toMatch(/API key has no person/);
    const task = await call(await PUT(req('PUT', '/api/providers', { bearer: 'bldt_task', body: { provider: 'anthropic', scope: 'mine', value: V.newKey, workspaceId: 'ws-1' } })));
    expect(task.status).toBe(403);
    expect(setProviderKey).not.toHaveBeenCalled();
  });

  it('a task token never writes, even its own workspace', async () => {
    const { status } = await call(await PUT(req('PUT', '/api/providers', { bearer: 'bldt_task', body: { provider: 'anthropic', scope: 'workspace', workspaceId: 'ws-1', value: V.newKey } })));
    expect(status).toBe(403);
    expect(replaceScoped).not.toHaveBeenCalled();
  });

  it('an admin API key writes a workspace seat token', async () => {
    const { status, body } = await call(await PUT(req('PUT', '/api/providers', { bearer: 'bld_admin', body: { provider: 'claude-subscription', scope: 'workspace', workspaceId: 'ws-1', value: V.newToken } })));
    expect(status).toBe(200);
    const [, meta] = replaceScoped.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(meta).toMatchObject({ purpose: 'oauth_token', workspaceId: 'ws-1' });
    expect(body.workspaceId).toBe('ws-1');
  });

  it('a worker-level API key cannot write team credentials', async () => {
    const { status } = await call(await PUT(req('PUT', '/api/providers', { bearer: 'bld_worker', body: { provider: 'anthropic', scope: 'team', value: V.newKey } })));
    expect(status).toBe(403);
  });

  it('refuses a seat token pasted as an API key, before anything is stored', async () => {
    asAdmin();
    const { status, body } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'anthropic', scope: 'team', value: V.newToken } })));
    expect(status).toBe(400);
    expect(body.error).toMatch(/sk-ant-api/);
    expect(replaceScoped).not.toHaveBeenCalled();
  });

  it('422s a provider that cannot serve the surface, with the registry’s reason verbatim', async () => {
    asAdmin();
    const { status, body } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'openai', scope: 'team', value: 'sk-x', surface: 'agent-claude' } })));
    expect(status).toBe(422);
    const support = providerDescriptor('openai').surfaces['agent-claude'];
    expect(support.ok).toBe(false);
    expect(body).toEqual({ error: 'provider_surface_unsupported', provider: 'openai', surface: 'agent-claude', reason: (support as any).reason, instead: (support as any).instead });
  });

  it('422s a scope the registry closes (a personal gateway)', async () => {
    asMember();
    const { status, body } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'litellm', scope: 'mine', value: 'k', config: { baseUrl: 'https://gw.example.com' } } })));
    expect(status).toBe(422);
    expect(body.error).toBe('provider_scope_unsupported');
  });

  it('sends a ChatGPT login to the browser instead of accepting a token', async () => {
    asAdmin();
    const { status, body } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'codex-subscription', scope: 'team', value: 'x' } })));
    expect(status).toBe(422);
    expect(body.error).toBe('connect_in_browser');
    expect(typeof body.url).toBe('string');
  });

  it('a gateway goes through the gateway function; an endpoint through the endpoint function', async () => {
    asAdmin();
    expect((await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'litellm', scope: 'team', value: V.gatewayKey, config: { baseUrl: 'https://gw.example.com/v1' } } })))).status).toBe(200);
    expect(setTeamGateway).toHaveBeenCalledWith({ teamId: 't-1', baseUrl: 'https://gw.example.com/v1', apiKey: V.gatewayKey });
    expect((await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'custom-endpoint', scope: 'workspace', workspaceId: 'ws-1', value: 'k-endpoint', config: { baseUrl: 'https://proxy.example.com' } } })))).status).toBe(200);
    expect(setTeamAgentEndpoint).toHaveBeenCalledWith({ teamId: 't-1', workspaceId: 'ws-1', endpoint: { kind: 'anthropic-compatible', baseUrl: 'https://proxy.example.com', apiKey: 'k-endpoint' } });
  });

  it('a member cannot set a gateway', async () => {
    asMember();
    const { status } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'litellm', scope: 'team', value: 'k', config: { baseUrl: 'https://gw.example.com' } } })));
    expect(status).toBe(403);
    expect(setTeamGateway).not.toHaveBeenCalled();
  });

  it('404s a workspace outside the team', async () => {
    asAdmin();
    workspaceExists = false;
    const { status } = await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'anthropic', scope: 'workspace', workspaceId: 'ws-x', value: V.newKey } })));
    expect(status).toBe(404);
  });

  it('400s unknown providers and scopes', async () => {
    asAdmin();
    expect((await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'nope', scope: 'team', value: 'x' } })))).status).toBe(400);
    expect((await call(await PUT(req('PUT', '/api/providers', { body: { provider: 'anthropic', scope: 'account', value: 'x' } })))).status).toBe(400);
  });
});

// ── DELETE ───────────────────────────────────────────────────────────────────

describe('DELETE /api/providers', () => {
  it('an admin removes the team rows of a provider', async () => {
    asAdmin();
    deleteReturns = [{ id: 'sec-1' }];
    const { status, body } = await call(await DELETE(req('DELETE', '/api/providers?provider=anthropic&scope=team')));
    expect(status).toBe(200);
    expect(body.deleted).toBe(1);
    expect(deleteCalls).toHaveLength(1);
  });

  it('a member cannot remove a team row, but can remove their own', async () => {
    asMember();
    expect((await call(await DELETE(req('DELETE', '/api/providers?provider=anthropic&scope=team')))).status).toBe(403);
    expect(deleteCalls).toHaveLength(0);
    const mine = await call(await DELETE(req('DELETE', '/api/providers?provider=anthropic&scope=mine')));
    expect(mine.status).toBe(200);
    expect(deleteProviderKey).toHaveBeenCalledWith({ teamId: 't-1', userId: 'u-member', provider: 'anthropic', scope: 'user' });
  });

  it('a task token cannot delete', async () => {
    expect((await call(await DELETE(req('DELETE', '/api/providers?provider=anthropic&scope=team', { bearer: 'bldt_task' })))).status).toBe(403);
  });
});

// ── PATCH (policy) ───────────────────────────────────────────────────────────

describe('PATCH /api/providers (credential policy)', () => {
  it('an admin sets the policy (both columns, so agent runs opt in)', async () => {
    asAdmin();
    const { status } = await call(await PATCH(req('PATCH', '/api/providers', { body: { credentialPolicy: 'personal_only' } })));
    expect(status).toBe(200);
    expect(updates[0]).toMatchObject({ credentialPolicy: 'personal_only', inferenceKeyPolicy: 'own' });
  });

  it('a member, a worker key and a task token cannot', async () => {
    asMember();
    expect((await call(await PATCH(req('PATCH', '/api/providers', { body: { credentialPolicy: 'team' } })))).status).toBe(403);
    sessionUser = null;
    expect((await call(await PATCH(req('PATCH', '/api/providers', { bearer: 'bld_worker', body: { credentialPolicy: 'team' } })))).status).toBe(403);
    expect((await call(await PATCH(req('PATCH', '/api/providers', { bearer: 'bldt_task', body: { credentialPolicy: 'team' } })))).status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it('400s an unknown policy', async () => {
    asAdmin();
    expect((await call(await PATCH(req('PATCH', '/api/providers', { body: { credentialPolicy: 'own' } })))).status).toBe(400);
  });
});

// ── The invariant ────────────────────────────────────────────────────────────

// Last in the file: bun runs tests in order, so every body above is recorded.
describe('no response carries a credential value', () => {
  it('scans every response body recorded in this file for every fixture value', async () => {
    // Exercise the read paths once more under every principal, then scan everything.
    asAdmin();
    await call(await GET(req('GET', '/api/providers?workspaceId=ws-1')));
    asMember();
    await call(await GET(req('GET', '/api/providers')));
    sessionUser = null;
    for (const bearer of ['bld_admin', 'oauth_member', 'bldt_task']) await call(await GET(req('GET', '/api/providers', { bearer })));
    expect(bodies.length).toBeGreaterThan(30);
    for (const body of bodies) {
      for (const value of FIXTURES) expect(body.includes(value) ? value : null).toBeNull();
      expect(body).not.toContain('enc:');
      expect(body).not.toContain('FIXTURE');
    }
  });
});
