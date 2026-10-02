/**
 * Settings-side management of the agent model endpoint
 * (docs/design/agent-model-endpoint.md §4, §6). Fixtures are illustrative;
 * nothing here is a real key.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const stored: Array<{ value: string; meta: any }> = [];
const updates: any[] = [];
let secretRows: any[] = [];
let secretRow: any = null;
let workspaceRow: any = null;
let gateway: { baseURL: string; apiKey: string } | null = null;
let registryRows: any[] = [];
const gatewayCalls: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({ set: (v: any) => ({ where: async () => { updates.push(v); return []; } }) }),
    delete: () => ({ where: () => ({ returning: async () => [{ id: 's-1' }] }) }),
    query: {
      secrets: { findMany: async () => secretRows, findFirst: async () => secretRow },
      workspaces: { findFirst: async () => workspaceRow, findMany: async () => (workspaceRow ? [workspaceRow] : []) },
      modelTierRegistry: { findMany: async () => registryRows },
    },
  },
}));
mock.module('@buildd/core/secrets', () => ({
  decrypt: (s: string) => s,
  getSecretsProvider: () => ({ replaceScoped: async (value: string, meta: any) => { stored.push({ value, meta }); return 's-1'; } }),
}));
const realGateway = { ...(await import('@buildd/core/litellm-gateway')) };
mock.module('@buildd/core/litellm-gateway', () => ({
  ...realGateway,
  resolveLiteLLMGateway: async (opts: any, flags: any) => { gatewayCalls.push({ opts, flags }); return gateway; },
}));

const { setTeamAgentEndpoint, listTeamAgentEndpoints, verifyAgentEndpointSecret, previewAgentEndpointModels, VERIFY_MODEL } = await import('./agent-endpoint-settings');

const KEY = 'sk-agent-example-1234';
const ok = async () => new Response('{}', { status: 200 });
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '169.254.169.254', family: 4 }];
const custom = { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com/', apiKey: KEY, authHeader: 'x-api-key' };

beforeEach(() => {
  stored.length = 0; updates.length = 0; gatewayCalls.length = 0;
  secretRows = []; secretRow = null; workspaceRow = null; gateway = null; registryRows = [];
});

describe('setTeamAgentEndpoint', () => {
  it('verifies with one Messages call, then stores a team-wide row (no account, no person)', async () => {
    const seen: any[] = [];
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, {
      lookup: publicLookup,
      fetcher: async (url, init) => { seen.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response('{}'); },
    });
    expect(r).toMatchObject({ ok: true, endpoint: { scope: 'team', baseUrl: 'https://litellm.example.com', authHeader: 'x-api-key', last4: '1234', health: 'healthy' } });
    // /v1/models first (here a reply that is not a list), then one Messages call.
    expect(seen.map((x) => x.url)).toEqual(['https://litellm.example.com/v1/models', 'https://litellm.example.com/v1/messages']);
    seen.shift();
    expect(seen[0].headers.get('x-api-key')).toBe(KEY);
    expect(seen[0].headers.get('authorization')).toBeNull();
    expect(seen[0].body).toMatchObject({ model: VERIFY_MODEL, max_tokens: 1 });
    expect(stored[0].meta).toEqual({ teamId: 't', purpose: 'agent_endpoint', userId: null });
    expect('accountId' in stored[0].meta).toBe(false);
    expect(JSON.parse(stored[0].value)).toEqual({ kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: KEY, authHeader: 'x-api-key' });
    expect(updates[0]).toMatchObject({ healthStatus: 'healthy', lastVerificationError: null });
    expect(updates[0].lastSuccessAt).toBeInstanceOf(Date);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('never stores an endpoint that rejects the key', async () => {
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, { lookup: publicLookup, fetcher: async () => new Response('bad key ' + KEY, { status: 401 }) });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(stored).toHaveLength(0);
  });

  it('an outage still saves, marked unknown', async () => {
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, { lookup: publicLookup, fetcher: async () => new Response('', { status: 503 }) });
    expect(r).toMatchObject({ ok: true, endpoint: { health: 'unknown' } });
    expect(updates[0].lastSuccessAt).toBeUndefined();
  });

  it('never stores an endpoint whose host is not public, and never calls it', async () => {
    let called = false;
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, { lookup: privateLookup, fetcher: async () => { called = true; return new Response('{}'); } });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(called).toBe(false);
    expect(stored).toHaveLength(0);
  });

  it('never stores an endpoint that redirects, and does not follow it', async () => {
    const urls: string[] = [];
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, {
      lookup: publicLookup,
      fetcher: async (url) => { urls.push(url); return new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }); },
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(urls).toEqual(['https://litellm.example.com/v1/models', 'https://litellm.example.com/v1/messages']);
    expect(stored).toHaveLength(0);
  });

  it('no reply text reaches the error or the stored row', async () => {
    const body = 'upstream said: internal detail';
    const rejected = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, { lookup: publicLookup, fetcher: async () => new Response(body, { status: 401 }) });
    expect(rejected).toEqual({ ok: false, status: 400, error: 'The endpoint rejected this key. endpoint rejected the key (401)' });
    const saved = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, { lookup: publicLookup, fetcher: async () => new Response(body, { status: 502 }) });
    expect(saved).toMatchObject({ ok: true, endpoint: { health: 'unknown', lastVerificationError: 'endpoint returned 502' } });
    expect(updates[0].lastVerificationError).toBe('endpoint returned 502');
    expect(JSON.stringify([rejected, saved, updates])).not.toContain('internal detail');
  });

  it('probes the alias target of the verify model when it is aliased', async () => {
    const bodies: any[] = [];
    gateway = { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-gateway-example-9876' };
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'gateway', models: { 'claude-sonnet-5': 'team-sonnet', [VERIFY_MODEL]: 'team-haiku' } } }, {
      lookup: publicLookup,
      fetcher: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response('{}'); },
    });
    expect(r.ok).toBe(true);
    expect(bodies.map((b) => b.model)).toEqual(['team-haiku']);
  });

  it('probes the first alias target when the verify model is not aliased', async () => {
    const bodies: any[] = [];
    gateway = { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-gateway-example-9876' };
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'gateway', models: { 'claude-sonnet-5': 'team-sonnet' } } }, {
      lookup: publicLookup,
      fetcher: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response('{}'); },
    });
    expect(r.ok).toBe(true);
    expect(bodies.map((b) => b.model)).toEqual(['team-sonnet']);
  });

  it('a 403 names the refused model and suggests an alias, does not blame the key, and saves nothing', async () => {
    gateway = { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-gateway-example-9876' };
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'gateway' } }, {
      lookup: publicLookup,
      fetcher: async () => new Response('key not allowed to access model', { status: 403 }),
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (r.ok) return;
    expect(r.error).toContain(VERIFY_MODEL);
    expect(r.error).toMatch(/alias/i);
    expect(r.error).not.toMatch(/rejected this key/);
    expect(r.error).not.toContain('sk-gateway-example-9876');
    expect(stored).toHaveLength(0);
  });

  it('a 401 still says the key was rejected', async () => {
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, { lookup: publicLookup, fetcher: async () => new Response('', { status: 401 }) });
    expect(r).toEqual({ ok: false, status: 400, error: 'The endpoint rejected this key. endpoint rejected the key (401)' });
  });

  it('a workspace scope must be one of this team\'s workspaces', async () => {
    workspaceRow = { id: 'ws-1', teamId: 'other', name: 'x' };
    expect(await setTeamAgentEndpoint({ teamId: 't', workspaceId: 'ws-1', endpoint: custom }, { lookup: publicLookup, fetcher: ok })).toMatchObject({ ok: false, status: 404 });
    workspaceRow = { id: 'ws-1', teamId: 't', name: 'x' };
    const r = await setTeamAgentEndpoint({ teamId: 't', workspaceId: 'ws-1', endpoint: custom }, { lookup: publicLookup, fetcher: ok });
    expect(r).toMatchObject({ ok: true, endpoint: { scope: 'workspace', workspaceId: 'ws-1' } });
    expect(stored[0].meta).toEqual({ teamId: 't', workspaceId: 'ws-1', purpose: 'agent_endpoint', userId: null });
  });

  it('the gateway option needs a gateway at that scope or broader, ignoring the key policy', async () => {
    expect(await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'gateway' } }, { lookup: publicLookup, fetcher: ok })).toMatchObject({ ok: false, status: 400 });
    gateway = { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-gateway-example-9876' };
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'gateway' } }, { lookup: publicLookup, fetcher: ok });
    expect(r).toMatchObject({ ok: true, endpoint: { kind: 'gateway', baseUrl: 'https://litellm.example.com', last4: '9876' } });
    expect(JSON.parse(stored[0].value)).toEqual({ kind: 'gateway' });
    expect(gatewayCalls.at(-1)).toEqual({ opts: { teamId: 't', workspaceId: null }, flags: { ignoreKeyPolicy: true } });
  });

  it('refuses invalid input without calling out', async () => {
    let called = false;
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'anthropic-compatible', baseUrl: 'http://litellm.example.com', apiKey: KEY } }, { lookup: publicLookup, fetcher: async () => { called = true; return new Response(); } });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});

/**
 * A fake endpoint: `/v1/models` answers `models` (a list of ids, a status
 * code, or a raw Response), `/v1/messages` answers 200 for `allowed` models
 * and 403 for the rest, the way a model-restricted LiteLLM key does.
 */
function fakeEndpoint(models: string[] | number | Response, allowed: string[] | 'all' = 'all') {
  const calls: Array<{ url: string; headers: Headers; model?: string }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, headers: new Headers(init?.headers), model: body?.model });
    if (url.endsWith('/v1/models')) {
      if (models instanceof Response) return models;
      if (typeof models === 'number') return new Response('{"error":"nope"}', { status: models });
      return new Response(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
    }
    if (allowed !== 'all' && !allowed.includes(body?.model)) {
      return new Response(`key not allowed to access model. Tried to access ${body?.model}`, { status: 403 });
    }
    return new Response('{}');
  };
  return { calls, fetcher, messages: () => calls.filter((c) => c.url.endsWith('/v1/messages')) };
}

describe('setTeamAgentEndpoint with model discovery', () => {
  const UNDATED = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

  it('a key restricted to undated names: probes the undated id, saves, and stores the same-model alias', async () => {
    const ep = fakeEndpoint(UNDATED, UNDATED);
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, { lookup: publicLookup, fetcher: ep.fetcher });
    expect(r).toMatchObject({ ok: true, endpoint: { health: 'healthy' } });
    expect(ep.calls[0].url).toBe('https://litellm.example.com/v1/models');
    expect(ep.calls[0].headers.get('x-api-key')).toBe(KEY);
    expect(ep.messages().map((c) => c.model)).toEqual(['claude-haiku-4-5']);
    expect(JSON.parse(stored[0].value).models).toEqual({ [VERIFY_MODEL]: 'claude-haiku-4-5' });
    if (r.ok) expect(r.endpoint.models).toEqual({ [VERIFY_MODEL]: 'claude-haiku-4-5' });
  });

  it('derives aliases for registry models too, never across families', async () => {
    registryRows = [
      { tier: 'standard', provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', surface: 'agent', workspaceId: null },
      { tier: 'premium', provider: 'anthropic', model: 'claude-opus-4-1-20250805', surface: null, workspaceId: null },
    ];
    const ep = fakeEndpoint(['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5']);
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, { lookup: publicLookup, fetcher: ep.fetcher });
    expect(r.ok).toBe(true);
    expect(JSON.parse(stored[0].value).models).toEqual({
      [VERIFY_MODEL]: 'claude-haiku-4-5',
      'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
    });
  });

  it('/v1/models 404: exactly the old behaviour (probe the verify model, store no aliases)', async () => {
    const ep = fakeEndpoint(404);
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, { lookup: publicLookup, fetcher: ep.fetcher });
    expect(r.ok).toBe(true);
    expect(ep.messages().map((c) => c.model)).toEqual([VERIFY_MODEL]);
    expect(JSON.parse(stored[0].value).models).toBeUndefined();
  });

  it('a derived alias never overrides an explicit one', async () => {
    const ep = fakeEndpoint([...UNDATED, 'team-haiku']);
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { ...custom, models: { [VERIFY_MODEL]: 'team-haiku' } } }, { lookup: publicLookup, fetcher: ep.fetcher });
    expect(r.ok).toBe(true);
    expect(ep.messages().map((c) => c.model)).toEqual(['team-haiku']);
    expect(JSON.parse(stored[0].value).models).toEqual({ [VERIFY_MODEL]: 'team-haiku' });
  });

  it('a refused probe names the model and a few listed models that look usable; never the key or the raw list', async () => {
    const raw = new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5' }, { id: 'claude-opus-5' }, { id: 'gpt-4o' }], note: 'internal-detail' }));
    const ep = fakeEndpoint(raw, []);
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { ...custom, models: { [VERIFY_MODEL]: 'claude-sonnet-5' } } }, { lookup: publicLookup, fetcher: ep.fetcher });
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (r.ok) return;
    expect(r.error).toContain('"claude-sonnet-5"');
    expect(r.error).toContain('claude-opus-5');
    expect(r.error).not.toContain('gpt-4o');
    expect(r.error).not.toContain(KEY);
    expect(r.error).not.toContain('internal-detail');
    expect(r.error).not.toContain('Tried to access');
    expect(stored).toHaveLength(0);
  });

  it('openrouter skips discovery', async () => {
    const ep = fakeEndpoint(['x']);
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'openrouter', apiKey: 'sk-or-example-5555' } }, { lookup: publicLookup, fetcher: ep.fetcher });
    expect(r.ok).toBe(true);
    expect(ep.calls.map((c) => c.url)).toEqual(['https://openrouter.ai/api/v1/messages']);
  });
});

describe('setTeamAgentEndpoint with a blank key', () => {
  const storedRow = (blob: unknown, workspaceId: string | null = null) => ({ id: 's-1', purpose: 'agent_endpoint', workspaceId, accountId: null, userId: null, encryptedValue: JSON.stringify(blob) });
  const saved = { ...custom, baseUrl: 'https://litellm.example.com', authHeader: 'x-api-key', models: { 'claude-opus-5': 'team-opus' } };

  it('same kind and URL at the same scope: keeps the stored key and header, verifies with it, never returns it', async () => {
    secretRows = [storedRow(saved)];
    const ep = fakeEndpoint(404);
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com/', models: { 'claude-opus-5': 'team-opus-2' } } }, { lookup: publicLookup, fetcher: ep.fetcher });
    expect(r).toMatchObject({ ok: true, endpoint: { last4: '1234', authHeader: 'x-api-key' } });
    expect(ep.messages()[0].headers.get('x-api-key')).toBe(KEY);
    expect(JSON.parse(stored[0].value)).toMatchObject({ apiKey: KEY, authHeader: 'x-api-key', models: { 'claude-opus-5': 'team-opus-2' } });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('an explicitly changed header is kept', async () => {
    secretRows = [storedRow(saved)];
    const ep = fakeEndpoint(404);
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: '', authHeader: 'authorization' } }, { lookup: publicLookup, fetcher: ep.fetcher });
    expect(r.ok).toBe(true);
    expect(ep.messages()[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('a changed URL, a changed kind, another scope, or nothing stored: refused, nothing called', async () => {
    const ep = fakeEndpoint(404);
    secretRows = [storedRow(saved)];
    for (const endpoint of [
      { kind: 'anthropic-compatible', baseUrl: 'https://elsewhere.example.com' },
      { kind: 'openrouter' },
    ]) {
      expect(await setTeamAgentEndpoint({ teamId: 't', endpoint }, { lookup: publicLookup, fetcher: ep.fetcher }))
        .toEqual({ ok: false, status: 400, error: 'Enter the key for this endpoint.' });
    }
    secretRows = [storedRow(saved, 'ws-1')];
    expect(await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com' } }, { lookup: publicLookup, fetcher: ep.fetcher }))
      .toMatchObject({ ok: false, status: 400 });
    expect(ep.calls).toHaveLength(0);
    expect(stored).toHaveLength(0);
  });
});

describe('previewAgentEndpointModels', () => {
  it('lists the endpoint\'s models and one prefilled row per model buildd asks for, without the key', async () => {
    const ep = fakeEndpoint(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
    const r = await previewAgentEndpointModels({ teamId: 't', endpoint: custom }, { lookup: publicLookup, fetcher: ep.fetcher });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.available).toBe(true);
    expect(r.listed).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
    const budget = r.rows.find((x) => x.model === VERIFY_MODEL);
    expect(budget).toMatchObject({ value: 'claude-haiku-4-5', source: 'equivalent', served: true });
    expect(budget!.tiers).toContain('budget');
    expect(r.rows.find((x) => x.model === 'claude-sonnet-5')).toMatchObject({ value: null, source: 'listed', served: true });
    expect(ep.calls.map((c) => c.url)).toEqual(['https://litellm.example.com/v1/models']);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('prefills from a mapping the team already made in the tier registry', async () => {
    registryRows = [{ tier: 'budget', provider: 'openrouter', model: 'google/gemini-2.5-flash', surface: 'chat', workspaceId: null }];
    const ep = fakeEndpoint(['claude-sonnet-5', 'gemini-2-5-flash']);
    const r = await previewAgentEndpointModels({ teamId: 't', endpoint: custom }, { lookup: publicLookup, fetcher: ep.fetcher });
    if (!r.ok) throw new Error(r.error);
    expect(r.rows.find((x) => x.model === VERIFY_MODEL)).toMatchObject({ value: 'gemini-2-5-flash', source: 'registry' });
  });

  it('without a key, uses the stored key of the same endpoint at that scope, and only for the same URL', async () => {
    secretRows = [{ id: 's-1', purpose: 'agent_endpoint', workspaceId: null, accountId: null, userId: null, encryptedValue: JSON.stringify({ ...custom, baseUrl: 'https://litellm.example.com', models: { 'claude-opus-5': 'team-opus' } }) }];
    const ep = fakeEndpoint(['claude-haiku-4-5', 'team-opus']);
    const r = await previewAgentEndpointModels({ teamId: 't', endpoint: { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', authHeader: 'x-api-key' } }, { lookup: publicLookup, fetcher: ep.fetcher });
    if (!r.ok) throw new Error(r.error);
    expect(ep.calls[0].headers.get('x-api-key')).toBe(KEY);
    expect(r.rows.find((x) => x.model === 'claude-opus-5')).toMatchObject({ value: 'team-opus', source: 'alias' });
    expect(JSON.stringify(r)).not.toContain(KEY);

    const other = await previewAgentEndpointModels({ teamId: 't', endpoint: { kind: 'anthropic-compatible', baseUrl: 'https://elsewhere.example.com' } }, { lookup: publicLookup, fetcher: ep.fetcher });
    expect(other).toMatchObject({ ok: false, status: 400 });
    expect(ep.calls).toHaveLength(1);
  });

  it('/v1/models unavailable: available false, rows unprefilled', async () => {
    const r = await previewAgentEndpointModels({ teamId: 't', endpoint: custom }, { lookup: publicLookup, fetcher: fakeEndpoint(404).fetcher });
    if (!r.ok) throw new Error(r.error);
    expect(r.available).toBe(false);
    expect(r.listed).toEqual([]);
    expect(r.rows.every((x) => x.served === null)).toBe(true);
  });

  it('a private host is never called', async () => {
    const ep = fakeEndpoint(['claude-haiku-4-5']);
    const r = await previewAgentEndpointModels({ teamId: 't', endpoint: custom }, { lookup: privateLookup, fetcher: ep.fetcher });
    expect(r).toMatchObject({ ok: true, available: false });
    expect(ep.calls).toHaveLength(0);
  });

  it('openrouter needs no mapping: nothing is fetched', async () => {
    const ep = fakeEndpoint(['x']);
    const r = await previewAgentEndpointModels({ teamId: 't', endpoint: { kind: 'openrouter', apiKey: 'sk-or-example-5555' } }, { lookup: publicLookup, fetcher: ep.fetcher });
    expect(r).toMatchObject({ ok: true, available: false });
    expect(ep.calls).toHaveLength(0);
  });
});

describe('listTeamAgentEndpoints', () => {
  it('masks the key and drops account/personal rows', async () => {
    workspaceRow = { id: 'ws-1', teamId: 't', name: 'Widgets' };
    const base = { purpose: 'agent_endpoint', accountId: null, userId: null, healthStatus: 'healthy', lastVerifiedAt: null, lastVerificationError: null, updatedAt: new Date('2026-01-01') };
    secretRows = [
      { ...base, id: 'a', workspaceId: 'ws-1', encryptedValue: JSON.stringify({ ...custom, baseUrl: 'https://litellm.example.com' }) },
      { ...base, id: 'b', workspaceId: null, encryptedValue: JSON.stringify({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api', apiKey: 'sk-or-example-5555', authHeader: 'authorization' }) },
      { ...base, id: 'c', workspaceId: null, accountId: 'acc', encryptedValue: JSON.stringify(custom) },
    ];
    const list = await listTeamAgentEndpoints('t');
    expect(list.map((e) => e.id)).toEqual(['b', 'a']);
    expect(list[1]).toMatchObject({ scope: 'workspace', workspaceName: 'Widgets', last4: '1234' });
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(JSON.stringify(list)).not.toContain('sk-or-example-5555');
  });

  it('carries the read-only mapping: each model buildd asks for, its tiers, and what goes on the wire', async () => {
    registryRows = [{ tier: 'standard', provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', surface: 'agent', workspaceId: null }];
    secretRows = [{
      id: 'a', purpose: 'agent_endpoint', workspaceId: null, accountId: null, userId: null, healthStatus: 'healthy', updatedAt: new Date(),
      encryptedValue: JSON.stringify({ ...custom, baseUrl: 'https://litellm.example.com', models: { [VERIFY_MODEL]: 'claude-haiku-4-5', 'claude-legacy-1': 'team-legacy' } }),
    }];
    const [e] = await listTeamAgentEndpoints('t');
    expect(e.mapping.find((m) => m.model === VERIFY_MODEL)).toEqual({ model: VERIFY_MODEL, tiers: ['budget'], sent: 'claude-haiku-4-5' });
    expect(e.mapping.find((m) => m.model === 'claude-sonnet-5')).toEqual({ model: 'claude-sonnet-5', tiers: ['standard'], sent: 'claude-sonnet-5' });
    expect(e.mapping.find((m) => m.model === 'claude-sonnet-4-5-20250929')?.tiers).toEqual(['standard']);
    expect(e.mapping.find((m) => m.model === 'claude-legacy-1')).toEqual({ model: 'claude-legacy-1', tiers: [], sent: 'team-legacy' });
    expect(JSON.stringify(e)).not.toContain(KEY);
  });

  it('flags a gateway reference whose gateway is gone', async () => {
    secretRows = [{ id: 'g', purpose: 'agent_endpoint', workspaceId: null, accountId: null, userId: null, healthStatus: 'unknown', updatedAt: new Date(), encryptedValue: JSON.stringify({ kind: 'gateway' }) }];
    expect((await listTeamAgentEndpoints('t'))[0]).toMatchObject({ kind: 'gateway', gatewayMissing: true, last4: '' });
  });
});

describe('verifyAgentEndpointSecret', () => {
  it('401 marks it revoked and scrubs the key; the result is recorded', async () => {
    secretRow = { id: 's-1', teamId: 't', workspaceId: null, purpose: 'agent_endpoint', encryptedValue: JSON.stringify(custom) };
    const r = await verifyAgentEndpointSecret('s-1', { lookup: publicLookup, fetcher: async () => new Response(`nope ${KEY}`, { status: 401 }) });
    expect(r.health).toBe('revoked');
    expect(r.error).not.toContain(KEY);
    expect(updates[0]).toMatchObject({ healthStatus: 'revoked' });
  });

  it('403 (model refused for this key) is recorded unknown, not revoked, so the row keeps routing', async () => {
    secretRow = { id: 's-1', teamId: 't', workspaceId: null, purpose: 'agent_endpoint', encryptedValue: JSON.stringify({ ...custom, models: { [VERIFY_MODEL]: 'team-haiku' } }) };
    const r = await verifyAgentEndpointSecret('s-1', { lookup: publicLookup, fetcher: async () => new Response('', { status: 403 }) });
    expect(r.health).toBe('unknown');
    expect(r.error).toContain('team-haiku');
    expect(updates[0]).toMatchObject({ healthStatus: 'unknown' });
  });

  it('a stored endpoint whose host is not public is recorded unknown without a request', async () => {
    secretRow = { id: 's-1', teamId: 't', workspaceId: null, purpose: 'agent_endpoint', encryptedValue: JSON.stringify(custom) };
    let called = false;
    const r = await verifyAgentEndpointSecret('s-1', { lookup: privateLookup, fetcher: async () => { called = true; return new Response('{}'); } });
    expect(r).toMatchObject({ health: 'unknown', error: 'the endpoint host is not a public address' });
    expect(called).toBe(false);
    expect(updates[0]).toMatchObject({ healthStatus: 'unknown', lastVerificationError: 'the endpoint host is not a public address' });
  });

  it('refuses a row of another purpose', async () => {
    secretRow = { id: 's-1', teamId: 't', workspaceId: null, purpose: 'anthropic_api_key', encryptedValue: 'x' };
    expect((await verifyAgentEndpointSecret('s-1', { lookup: publicLookup, fetcher: ok })).error).toMatch(/Not an agent endpoint/);
    expect(updates).toHaveLength(0);
  });
});
