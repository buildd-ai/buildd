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
const gatewayCalls: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({ set: (v: any) => ({ where: async () => { updates.push(v); return []; } }) }),
    delete: () => ({ where: () => ({ returning: async () => [{ id: 's-1' }] }) }),
    query: {
      secrets: { findMany: async () => secretRows, findFirst: async () => secretRow },
      workspaces: { findFirst: async () => workspaceRow, findMany: async () => (workspaceRow ? [workspaceRow] : []) },
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

const { setTeamAgentEndpoint, listTeamAgentEndpoints, verifyAgentEndpointSecret, VERIFY_MODEL } = await import('./agent-endpoint-settings');

const KEY = 'sk-agent-example-1234';
const ok = async () => new Response('{}', { status: 200 });
const custom = { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com/', apiKey: KEY, authHeader: 'x-api-key' };

beforeEach(() => {
  stored.length = 0; updates.length = 0; gatewayCalls.length = 0;
  secretRows = []; secretRow = null; workspaceRow = null; gateway = null;
});

describe('setTeamAgentEndpoint', () => {
  it('verifies with one Messages call, then stores a team-wide row (no account, no person)', async () => {
    const seen: any[] = [];
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, {
      fetcher: async (url, init) => { seen.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }); return new Response('{}'); },
    });
    expect(r).toMatchObject({ ok: true, endpoint: { scope: 'team', baseUrl: 'https://litellm.example.com', authHeader: 'x-api-key', last4: '1234', health: 'healthy' } });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://litellm.example.com/v1/messages');
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
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, { fetcher: async () => new Response('bad key ' + KEY, { status: 401 }) });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(stored).toHaveLength(0);
  });

  it('an outage still saves, marked unknown', async () => {
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: custom }, { fetcher: async () => new Response('', { status: 503 }) });
    expect(r).toMatchObject({ ok: true, endpoint: { health: 'unknown' } });
    expect(updates[0].lastSuccessAt).toBeUndefined();
  });

  it('a workspace scope must be one of this team\'s workspaces', async () => {
    workspaceRow = { id: 'ws-1', teamId: 'other', name: 'x' };
    expect(await setTeamAgentEndpoint({ teamId: 't', workspaceId: 'ws-1', endpoint: custom }, { fetcher: ok })).toMatchObject({ ok: false, status: 404 });
    workspaceRow = { id: 'ws-1', teamId: 't', name: 'x' };
    const r = await setTeamAgentEndpoint({ teamId: 't', workspaceId: 'ws-1', endpoint: custom }, { fetcher: ok });
    expect(r).toMatchObject({ ok: true, endpoint: { scope: 'workspace', workspaceId: 'ws-1' } });
    expect(stored[0].meta).toEqual({ teamId: 't', workspaceId: 'ws-1', purpose: 'agent_endpoint', userId: null });
  });

  it('the gateway option needs a gateway at that scope or broader, ignoring the key policy', async () => {
    expect(await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'gateway' } }, { fetcher: ok })).toMatchObject({ ok: false, status: 400 });
    gateway = { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-gateway-example-9876' };
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'gateway' } }, { fetcher: ok });
    expect(r).toMatchObject({ ok: true, endpoint: { kind: 'gateway', baseUrl: 'https://litellm.example.com', last4: '9876' } });
    expect(JSON.parse(stored[0].value)).toEqual({ kind: 'gateway' });
    expect(gatewayCalls.at(-1)).toEqual({ opts: { teamId: 't', workspaceId: null }, flags: { ignoreKeyPolicy: true } });
  });

  it('refuses invalid input without calling out', async () => {
    let called = false;
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'anthropic-compatible', baseUrl: 'http://litellm.example.com', apiKey: KEY } }, { fetcher: async () => { called = true; return new Response(); } });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
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

  it('flags a gateway reference whose gateway is gone', async () => {
    secretRows = [{ id: 'g', purpose: 'agent_endpoint', workspaceId: null, accountId: null, userId: null, healthStatus: 'unknown', updatedAt: new Date(), encryptedValue: JSON.stringify({ kind: 'gateway' }) }];
    expect((await listTeamAgentEndpoints('t'))[0]).toMatchObject({ kind: 'gateway', gatewayMissing: true, last4: '' });
  });
});

describe('verifyAgentEndpointSecret', () => {
  it('401 marks it revoked and scrubs the key; the result is recorded', async () => {
    secretRow = { id: 's-1', teamId: 't', workspaceId: null, purpose: 'agent_endpoint', encryptedValue: JSON.stringify(custom) };
    const r = await verifyAgentEndpointSecret('s-1', { fetcher: async () => new Response(`nope ${KEY}`, { status: 401 }) });
    expect(r.health).toBe('revoked');
    expect(r.error).not.toContain(KEY);
    expect(updates[0]).toMatchObject({ healthStatus: 'revoked' });
  });

  it('refuses a row of another purpose', async () => {
    secretRow = { id: 's-1', teamId: 't', workspaceId: null, purpose: 'anthropic_api_key', encryptedValue: 'x' };
    expect((await verifyAgentEndpointSecret('s-1', { fetcher: ok })).error).toMatch(/Not an agent endpoint/);
    expect(updates).toHaveLength(0);
  });
});
