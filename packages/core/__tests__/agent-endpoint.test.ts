/**
 * The agent model endpoint secret (docs/design/agent-model-endpoint.md §1, §5).
 * Pure helpers only; resolution is covered in agent-endpoint-resolve.test.ts.
 * Fixtures are illustrative, nothing here is a real key.
 */
import { describe, expect, it } from 'bun:test';
import {
  AGENT_ENDPOINT_PURPOSE,
  OPENROUTER_AGENT_BASE_URL,
  agentBaseUrlFromGateway,
  agentEndpointProbeModel,
  mapAgentModel,
  parseAgentEndpointBlob,
  resolveEndpointFromBlob,
  serializeAgentEndpoint,
  validateAgentEndpointInput,
  verifyAgentEndpoint,
} from '../agent-endpoint';
import { openRouterModelId } from '../openrouter-id';

describe('agent endpoint blob', () => {
  it('purpose is agent_endpoint', () => {
    expect(AGENT_ENDPOINT_PURPOSE).toBe('agent_endpoint');
  });

  it('round-trips a self-contained endpoint and normalises the URL', () => {
    const v = validateAgentEndpointInput({
      kind: 'anthropic-compatible',
      baseUrl: ' https://litellm.example.com/ ',
      apiKey: ' sk-agent-1 ',
      authHeader: 'x-api-key',
      models: { 'claude-sonnet-5': 'team-sonnet' },
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const stored = serializeAgentEndpoint(v.blob);
    expect(JSON.parse(stored)).toEqual({
      kind: 'anthropic-compatible',
      baseUrl: 'https://litellm.example.com',
      apiKey: 'sk-agent-1',
      authHeader: 'x-api-key',
      models: { 'claude-sonnet-5': 'team-sonnet' },
    });
    expect(parseAgentEndpointBlob(stored)).toEqual(v.blob);
  });

  it('defaults authHeader to authorization and OpenRouter to its API root', () => {
    const v = validateAgentEndpointInput({ kind: 'openrouter', apiKey: 'sk-or-1' });
    expect(v.ok && v.blob).toEqual({ kind: 'openrouter', baseUrl: OPENROUTER_AGENT_BASE_URL, apiKey: 'sk-or-1', authHeader: 'authorization' });
  });

  it('the gateway reference carries no key and no URL unless overridden', () => {
    const v = validateAgentEndpointInput({ kind: 'gateway' });
    expect(v.ok && v.blob).toEqual({ kind: 'gateway' });
    const o = validateAgentEndpointInput({ kind: 'gateway', agentBaseUrl: 'https://litellm.example.com/anthropic/' });
    expect(o.ok && o.blob).toEqual({ kind: 'gateway', agentBaseUrl: 'https://litellm.example.com/anthropic' });
    // A key in a gateway reference is refused: it would silently not be used.
    expect(validateAgentEndpointInput({ kind: 'gateway', apiKey: 'sk-x' }).ok).toBe(false);
  });

  it('refuses what it cannot route', () => {
    const bad = [
      null,
      'x',
      {},
      { kind: 'anthropic' },
      { kind: 'anthropic-compatible', apiKey: 'k' },
      { kind: 'anthropic-compatible', baseUrl: 'http://litellm.example.com', apiKey: 'k' },
      { kind: 'anthropic-compatible', baseUrl: 'https://u:p@litellm.example.com', apiKey: 'k' },
      { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: '' },
      { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: 'has space' },
      { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: 'k', authHeader: 'cookie' },
      { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: 'k', models: { a: 1 } },
      { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: 'k', models: [] },
    ];
    for (const b of bad) expect(validateAgentEndpointInput(b).ok).toBe(false);
  });

  it('reads anything malformed as no endpoint', () => {
    expect(parseAgentEndpointBlob(null)).toBeNull();
    expect(parseAgentEndpointBlob('sk-plain')).toBeNull();
    expect(parseAgentEndpointBlob(JSON.stringify({ kind: 'anthropic-compatible', baseUrl: 'http://x.example.com', apiKey: 'k' }))).toBeNull();
  });
});

describe('gateway reference → agent base', () => {
  it('drops a trailing /v1 from the OpenAI root', () => {
    expect(agentBaseUrlFromGateway('https://litellm.example.com/v1')).toBe('https://litellm.example.com');
    expect(agentBaseUrlFromGateway('https://litellm.example.com/v1/')).toBe('https://litellm.example.com');
    expect(agentBaseUrlFromGateway('https://litellm.example.com')).toBe('https://litellm.example.com');
    expect(agentBaseUrlFromGateway('https://litellm.example.com/proxy/v1')).toBe('https://litellm.example.com/proxy');
  });

  it('resolves to the gateway key and derived base, or the override', () => {
    const gw = { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-gw' };
    expect(resolveEndpointFromBlob({ kind: 'gateway' }, gw)).toEqual({
      kind: 'gateway', baseUrl: 'https://litellm.example.com', apiKey: 'sk-gw', authHeader: 'authorization', models: {},
    });
    expect(resolveEndpointFromBlob({ kind: 'gateway', agentBaseUrl: 'https://litellm.example.com/anthropic' }, gw)?.baseUrl)
      .toBe('https://litellm.example.com/anthropic');
    // A reference with no gateway to point at routes nothing.
    expect(resolveEndpointFromBlob({ kind: 'gateway' }, null)).toBeNull();
  });

  it('a self-contained blob ignores the gateway', () => {
    const r = resolveEndpointFromBlob({ kind: 'openrouter', baseUrl: OPENROUTER_AGENT_BASE_URL, apiKey: 'sk-or', authHeader: 'authorization' }, { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-gw' });
    expect(r).toEqual({ kind: 'openrouter', baseUrl: OPENROUTER_AGENT_BASE_URL, apiKey: 'sk-or', authHeader: 'authorization', models: {} });
  });
});

describe('mapAgentModel (§5)', () => {
  it('openrouter uses the chat rule (dotted, undated)', () => {
    expect(mapAgentModel({ kind: 'openrouter', models: {} }, 'claude-haiku-4-5-20251001')).toBe(openRouterModelId('anthropic', 'claude-haiku-4-5-20251001'));
    expect(mapAgentModel({ kind: 'openrouter', models: {} }, 'claude-haiku-4-5-20251001')).toBe('anthropic/claude-haiku-4.5');
  });

  it('gateway / anthropic-compatible: the alias map, else the id unchanged, never a provider/ prefix', () => {
    for (const kind of ['gateway', 'anthropic-compatible'] as const) {
      expect(mapAgentModel({ kind, models: { 'claude-sonnet-5': 'team-sonnet' } }, 'claude-sonnet-5')).toBe('team-sonnet');
      expect(mapAgentModel({ kind, models: {} }, 'claude-opus-4-8')).toBe('claude-opus-4-8');
    }
  });

  it('a same-model alias stored at save (dated tier id → listed undated name) reaches the wire through the route', () => {
    // Settings stores discovered aliases in the same `models` map as the
    // person's; the claim and the runner map through resolveEndpointFromBlob's route.
    const blob = parseAgentEndpointBlob(JSON.stringify({
      kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: 'sk-agent-1', authHeader: 'authorization',
      models: { 'claude-haiku-4-5-20251001': 'claude-haiku-4-5' },
    }))!;
    const route = resolveEndpointFromBlob(blob, null)!;
    expect(mapAgentModel(route, 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(mapAgentModel(route, 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });
});

describe('agentEndpointProbeModel', () => {
  const fallback = 'claude-haiku-4-5';
  it('no alias table: the fallback', () => {
    expect(agentEndpointProbeModel({ kind: 'gateway', models: {} }, fallback)).toBe(fallback);
  });
  it('the fallback itself is aliased: the fallback (so its alias target is what goes on the wire)', () => {
    const r = { kind: 'gateway' as const, models: { 'claude-sonnet-5': 'team-sonnet', [fallback]: 'team-haiku' } };
    expect(mapAgentModel(r, agentEndpointProbeModel(r, fallback))).toBe('team-haiku');
  });
  it('aliases that skip the fallback: the first aliased model', () => {
    const r = { kind: 'anthropic-compatible' as const, models: { 'claude-sonnet-5': 'team-sonnet', 'claude-opus-4-8': 'team-opus' } };
    expect(mapAgentModel(r, agentEndpointProbeModel(r, fallback))).toBe('team-sonnet');
  });
  it('openrouter ignores aliases, so it probes the fallback', () => {
    expect(agentEndpointProbeModel({ kind: 'openrouter', models: { 'claude-sonnet-5': 'x' } }, fallback)).toBe(fallback);
  });
});

describe('verifyAgentEndpoint', () => {
  const route = { kind: 'anthropic-compatible' as const, baseUrl: 'https://llm.example.com', apiKey: 'sk-agent-example', authHeader: 'authorization' as const, models: {} };
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  it('a public endpoint that accepts the key is healthy; the request is POST /v1/messages with redirect: manual', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const r = await verifyAgentEndpoint(route, 'claude-haiku-4-5', { lookup: publicLookup, fetcher: async (url, init) => { seen = { url, init }; return new Response('{}'); } });
    expect(r).toEqual({ health: 'healthy', error: null });
    expect(seen!.url).toBe('https://llm.example.com/v1/messages');
    expect(seen!.init?.redirect).toBe('manual');
    expect(new Headers(seen!.init?.headers).get('authorization')).toBe('Bearer sk-agent-example');
  });

  it('errors are a fixed message and a status code, never the reply', async () => {
    const body = 'secret internal detail sk-agent-example';
    const revoked = await verifyAgentEndpoint(route, 'm', { lookup: publicLookup, fetcher: async () => new Response(body, { status: 401 }) });
    expect(revoked).toEqual({ health: 'revoked', error: 'endpoint rejected the key (401)' });
    const down = await verifyAgentEndpoint(route, 'm', { lookup: publicLookup, fetcher: async () => new Response(body, { status: 502 }) });
    expect(down).toEqual({ health: 'unknown', error: 'endpoint returned 502' });
    const net = await verifyAgentEndpoint(route, 'm', { lookup: publicLookup, fetcher: async () => { throw new Error(body); } });
    expect(net).toEqual({ health: 'unknown', error: 'could not reach the endpoint' });
  });

  it('wire: the model is sent as given, not mapped again', async () => {
    const aliased = { ...route, models: { 'claude-haiku-4-5': 'team-haiku' } };
    let sent = '';
    await verifyAgentEndpoint(aliased, 'claude-haiku-4-5', { lookup: publicLookup, wire: true, fetcher: async (_u, init) => { sent = JSON.parse(String(init?.body)).model; return new Response('{}'); } });
    expect(sent).toBe('claude-haiku-4-5');
  });

  it('a 403 is the model refused for this key, not a dead key: unknown, naming the wire model', async () => {
    const aliased = { ...route, models: { 'claude-haiku-4-5': 'team-haiku' } };
    const r = await verifyAgentEndpoint(aliased, 'claude-haiku-4-5', { lookup: publicLookup, fetcher: async () => new Response('key not allowed sk-agent-example', { status: 403 }) });
    expect(r.health).toBe('unknown');
    expect(r.refusedModel).toBe('team-haiku');
    expect(r.error).toContain('team-haiku');
    expect(r.error).toContain('(403)');
    expect(r.error).toMatch(/alias/);
    expect(r.error).not.toContain('sk-agent-example');
    expect(r.error).not.toContain('not allowed sk');
  });

  it('a 401 is still a rejected key', async () => {
    const r = await verifyAgentEndpoint(route, 'm', { lookup: publicLookup, fetcher: async () => new Response('', { status: 401 }) });
    expect(r).toEqual({ health: 'revoked', error: 'endpoint rejected the key (401)' });
  });

  it('private and metadata addresses are refused without a request', async () => {
    for (const address of ['10.1.2.3', '169.254.169.254', '127.0.0.1', '100.64.1.1', 'fd00::1', '::ffff:169.254.169.254']) {
      let calls = 0;
      const r = await verifyAgentEndpoint(route, 'm', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }],
        fetcher: async () => { calls++; return new Response('{}'); },
      });
      expect(r).toEqual({ health: 'unknown', error: 'the endpoint host is not a public address', blocked: true });
      expect(calls).toBe(0);
    }
  });

  it('a redirect is not followed', async () => {
    const urls: string[] = [];
    const r = await verifyAgentEndpoint(route, 'm', {
      lookup: publicLookup,
      fetcher: async (url) => { urls.push(url); return new Response(null, { status: 307, headers: { location: 'http://10.0.0.1/' } }); },
    });
    expect(r).toEqual({ health: 'unknown', error: 'endpoint answered with a redirect (307), which is not followed', blocked: true });
    expect(urls).toEqual(['https://llm.example.com/v1/messages']);
  });
});
