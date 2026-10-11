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
  effectiveToolSearch,
  endpointAppliesTo,
  isEndpointReference,
  isOpenRouterReference,
  mapAgentModel,
  parseAgentEndpointBlob,
  resolveEndpointFromBlob,
  serializeAgentEndpoint,
  validateAgentEndpointInput,
  verifyAgentEndpoint,
  routeNeedsHeaders,
  cloudflareAgentBaseUrl,
  CLOUDFLARE_AI_GATEWAY_ROOT,
} from '../agent-endpoint';
import { openRouterModelId } from '../openrouter-id';
import { jevGatewayBaseURL } from '../cloudflare-ai-gateway';
import { CLOUDFLARE_AI_GATEWAY_ROOT as KIT_GATEWAY_ROOT } from '@builddai/ai-kit/models/routes';

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

  it('an OpenRouter endpoint without a key is a reference; with one it is legacy inline', () => {
    for (const apiKey of [undefined, null, '']) {
      const v = validateAgentEndpointInput({ kind: 'openrouter', apiKey });
      expect(v.ok && v.blob).toEqual({ kind: 'openrouter', baseUrl: OPENROUTER_AGENT_BASE_URL, authHeader: 'authorization' });
      if (v.ok) {
        expect(isOpenRouterReference(v.blob)).toBe(true);
        expect(isEndpointReference(v.blob)).toBe(true);
        expect(parseAgentEndpointBlob(serializeAgentEndpoint(v.blob))).toEqual(v.blob);
      }
    }
    const inline = validateAgentEndpointInput({ kind: 'openrouter', apiKey: 'sk-or-1' });
    expect(inline.ok && isOpenRouterReference(inline.blob)).toBe(false);
    // A custom URL still needs its own key: there is nothing to reference.
    expect(validateAgentEndpointInput({ kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com' }).ok).toBe(false);
    // A key that is present but malformed is refused, not read as a reference.
    expect(validateAgentEndpointInput({ kind: 'openrouter', apiKey: 'has space' }).ok).toBe(false);
    expect(validateAgentEndpointInput({ kind: 'openrouter', apiKey: 7 }).ok).toBe(false);
  });

  it('an OpenRouter reference routes the referenced key; an inline key wins over it', () => {
    const ref = { kind: 'openrouter' as const, baseUrl: OPENROUTER_AGENT_BASE_URL, authHeader: 'authorization' as const };
    expect(resolveEndpointFromBlob(ref, null)).toBeNull();
    expect(resolveEndpointFromBlob(ref, null, 'sk-or-stored')).toMatchObject({ kind: 'openrouter', apiKey: 'sk-or-stored', openAiBaseUrl: `${OPENROUTER_AGENT_BASE_URL}/v1` });
    expect(resolveEndpointFromBlob({ ...ref, apiKey: 'sk-or-inline' }, null, 'sk-or-stored')?.apiKey).toBe('sk-or-inline');
  });

  it('capabilities.legacyInlineKey round-trips and is not a routing flag', () => {
    const v = validateAgentEndpointInput({ kind: 'openrouter', apiKey: 'sk-or-1', capabilities: { legacyInlineKey: true } });
    expect(v.ok && v.blob.capabilities).toEqual({ legacyInlineKey: true });
    if (v.ok) expect(resolveEndpointFromBlob(v.blob, null)?.toolSearch).toBe(true);
    expect(validateAgentEndpointInput({ kind: 'openrouter', capabilities: { legacyInlineKey: 'yes' } }).ok).toBe(false);
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

  it('appliesTo: absent = all workspaces; a list is trimmed and de-duplicated; both kinds keep it', () => {
    const none = validateAgentEndpointInput({ kind: 'openrouter', apiKey: 'sk-or-1', appliesTo: null });
    expect(none.ok && 'appliesTo' in none.blob).toBe(false);
    const v = validateAgentEndpointInput({ kind: 'openrouter', apiKey: 'sk-or-1', appliesTo: [' ws-a ', 'ws-b', 'ws-a'] });
    expect(v.ok && v.blob.appliesTo).toEqual(['ws-a', 'ws-b']);
    const g = validateAgentEndpointInput({ kind: 'gateway', appliesTo: ['ws-a'] });
    expect(g.ok && g.blob).toEqual({ kind: 'gateway', appliesTo: ['ws-a'] });
    if (v.ok) expect(parseAgentEndpointBlob(serializeAgentEndpoint(v.blob))).toEqual(v.blob);
  });

  it('appliesTo: refuses an empty list or a non-string entry', () => {
    for (const appliesTo of [[], 'ws-a', [1], [''], ['has space'], {}]) {
      expect(validateAgentEndpointInput({ kind: 'openrouter', apiKey: 'k', appliesTo }).ok).toBe(false);
    }
  });

  it('endpointAppliesTo: team rows honour the list, workspace rows always apply', () => {
    const blob = { kind: 'gateway' as const, appliesTo: ['ws-a'] };
    expect(endpointAppliesTo(blob, null, 'ws-a')).toBe(true);
    expect(endpointAppliesTo(blob, null, 'ws-b')).toBe(false);
    expect(endpointAppliesTo(blob, null, null)).toBe(false);
    expect(endpointAppliesTo(blob, 'ws-b', 'ws-b')).toBe(true);
    expect(endpointAppliesTo({ kind: 'gateway' }, null, null)).toBe(true);
    expect(endpointAppliesTo({ kind: 'gateway' }, null, 'ws-b')).toBe(true);
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
      // The OpenAI-compatible root for Codex is the gateway's own root, unaffected by the Anthropic-side derivation above.
      openAiBaseUrl: 'https://litellm.example.com/v1',
      toolSearch: false,
    });
    expect(resolveEndpointFromBlob({ kind: 'gateway', agentBaseUrl: 'https://litellm.example.com/anthropic' }, gw)?.baseUrl)
      .toBe('https://litellm.example.com/anthropic');
    expect(resolveEndpointFromBlob({ kind: 'gateway', agentBaseUrl: 'https://litellm.example.com/anthropic' }, gw)?.openAiBaseUrl)
      .toBe('https://litellm.example.com/v1');
    // A reference with no gateway to point at routes nothing.
    expect(resolveEndpointFromBlob({ kind: 'gateway' }, null)).toBeNull();
  });

  it('a self-contained blob ignores the gateway', () => {
    const r = resolveEndpointFromBlob({ kind: 'openrouter', baseUrl: OPENROUTER_AGENT_BASE_URL, apiKey: 'sk-or', authHeader: 'authorization' }, { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-gw' });
    expect(r).toEqual({
      kind: 'openrouter', baseUrl: OPENROUTER_AGENT_BASE_URL, apiKey: 'sk-or', authHeader: 'authorization', models: {},
      openAiBaseUrl: `${OPENROUTER_AGENT_BASE_URL}/v1`,
      toolSearch: true,
    });
  });

  it('anthropic-compatible has no OpenAI-compatible route: openAiBaseUrl is absent', () => {
    const r = resolveEndpointFromBlob({ kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: 'sk-agent', authHeader: 'authorization' }, null);
    expect(r?.openAiBaseUrl).toBeUndefined();
  });

  it('openrouter\'s OpenAI-compatible root is its Anthropic-compatible root plus /v1', () => {
    const r = resolveEndpointFromBlob({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api', apiKey: 'sk-or', authHeader: 'authorization' }, null);
    expect(r?.openAiBaseUrl).toBe('https://openrouter.ai/api/v1');
  });
});

describe('capabilities.toolSearch (deferred tool loading)', () => {
  const gw = { baseURL: 'https://litellm.example.com/v1', apiKey: 'sk-gw' };
  const custom = { kind: 'anthropic-compatible' as const, baseUrl: 'https://litellm.example.com', apiKey: 'k', authHeader: 'authorization' as const };
  const or = { kind: 'openrouter' as const, baseUrl: OPENROUTER_AGENT_BASE_URL, apiKey: 'k', authHeader: 'authorization' as const };

  it('kind defaults: openrouter on, gateway and anthropic-compatible off', () => {
    expect(effectiveToolSearch('openrouter')).toBe(true);
    expect(effectiveToolSearch('gateway')).toBe(false);
    expect(effectiveToolSearch('anthropic-compatible')).toBe(false);
  });

  it('an explicit value wins either way, including the OpenRouter escape hatch', () => {
    expect(effectiveToolSearch('openrouter', { toolSearch: false })).toBe(false);
    expect(effectiveToolSearch('gateway', { toolSearch: true })).toBe(true);
    expect(effectiveToolSearch('anthropic-compatible', { toolSearch: true })).toBe(true);
  });

  it('resolves into the route for every kind', () => {
    expect(resolveEndpointFromBlob({ kind: 'gateway', capabilities: { toolSearch: true } }, gw)?.toolSearch).toBe(true);
    expect(resolveEndpointFromBlob({ kind: 'gateway' }, gw)?.toolSearch).toBe(false);
    expect(resolveEndpointFromBlob(custom, null)?.toolSearch).toBe(false);
    expect(resolveEndpointFromBlob({ ...custom, capabilities: { toolSearch: true } }, null)?.toolSearch).toBe(true);
    expect(resolveEndpointFromBlob(or, null)?.toolSearch).toBe(true);
    expect(resolveEndpointFromBlob({ ...or, capabilities: { toolSearch: false } }, null)?.toolSearch).toBe(false);
  });

  it('validates, stores only what was set, and round-trips', () => {
    const g = validateAgentEndpointInput({ kind: 'gateway', capabilities: { toolSearch: true } });
    expect(g.ok && g.blob).toEqual({ kind: 'gateway', capabilities: { toolSearch: true } });
    const o = validateAgentEndpointInput({ kind: 'openrouter', apiKey: 'k', capabilities: { toolSearch: false } });
    expect(o.ok && o.blob.capabilities).toEqual({ toolSearch: false });
    if (o.ok) expect(parseAgentEndpointBlob(serializeAgentEndpoint(o.blob))).toEqual(o.blob);
    for (const capabilities of [null, {}, { toolSearch: null }]) {
      const v = validateAgentEndpointInput({ kind: 'gateway', capabilities });
      expect(v.ok && 'capabilities' in v.blob).toBe(false);
    }
  });

  it('refuses a non-boolean flag or an unknown capability', () => {
    for (const capabilities of [{ toolSearch: 'yes' }, { toolSearch: 1 }, { other: true }, [], 'on']) {
      expect(validateAgentEndpointInput({ kind: 'gateway', capabilities }).ok).toBe(false);
    }
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

describe('cloudflare endpoint', () => {
  const ACCOUNT = '0123456789abcdef0123456789abcdef';
  const GW_TOKEN = 'cf-gateway-run-token-abcdefghijklmnop';
  const ref = (o: Partial<{ gatewayId: string | null; upstreamKey: string | null }> = {}) =>
    ({ accountId: ACCOUNT, gatewayId: 'buildd', upstreamKey: 'sk-ant-api03-example', ...o });

  it('validates to a reference with no URL or key of its own', () => {
    expect(validateAgentEndpointInput({ kind: 'cloudflare' })).toEqual({ ok: true, blob: { kind: 'cloudflare', upstream: 'anthropic' } });
    expect(validateAgentEndpointInput({ kind: 'cloudflare', upstream: 'openrouter', gatewayToken: ` ${GW_TOKEN} ` }))
      .toEqual({ ok: true, blob: { kind: 'cloudflare', upstream: 'openrouter', gatewayToken: GW_TOKEN } });
    expect(validateAgentEndpointInput({ kind: 'cloudflare', baseUrl: 'https://x.example.com' }).ok).toBe(false);
    expect(validateAgentEndpointInput({ kind: 'cloudflare', apiKey: 'k' }).ok).toBe(false);
    expect(validateAgentEndpointInput({ kind: 'cloudflare', upstream: 'openai' }).ok).toBe(false);
    expect(validateAgentEndpointInput({ kind: 'cloudflare', gatewayToken: 'short' }).ok).toBe(false);
    expect(isEndpointReference({ kind: 'cloudflare', upstream: 'anthropic' })).toBe(true);
  });

  it("routes Anthropic through the gateway's anthropic path on the Anthropic key", () => {
    const route = resolveEndpointFromBlob({ kind: 'cloudflare', upstream: 'anthropic' }, null, null, ref());
    expect(route).toEqual({
      kind: 'cloudflare', upstream: 'anthropic',
      baseUrl: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/buildd/anthropic`,
      apiKey: 'sk-ant-api03-example', authHeader: 'x-api-key', models: {}, toolSearch: true,
    });
    expect(routeNeedsHeaders(route!)).toBe(false);
  });

  it('sends the gateway token as cf-aig-authorization, and then offers no Codex route', () => {
    const route = resolveEndpointFromBlob({ kind: 'cloudflare', upstream: 'openrouter', gatewayToken: GW_TOKEN }, null, null, ref({ upstreamKey: 'sk-or-v1-example' }));
    expect(route?.baseUrl).toBe(`https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/buildd/openrouter`);
    expect(route?.authHeader).toBe('authorization');
    expect(route?.headers).toEqual({ 'cf-aig-authorization': `Bearer ${GW_TOKEN}` });
    expect(route?.openAiBaseUrl).toBeUndefined();
    expect(routeNeedsHeaders(route!)).toBe(true);
    const open = resolveEndpointFromBlob({ kind: 'cloudflare', upstream: 'openrouter' }, null, null, ref({ upstreamKey: 'sk-or-v1-example' }));
    expect(open?.openAiBaseUrl).toBe(`https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/buildd/openrouter/v1`);
  });

  it('routes nothing without a gateway, an upstream key, or a well-formed account', () => {
    const blob = { kind: 'cloudflare' as const, upstream: 'anthropic' as const };
    expect(resolveEndpointFromBlob(blob, null, null, null)).toBeNull();
    expect(resolveEndpointFromBlob(blob, null, null, ref({ gatewayId: null }))).toBeNull();
    expect(resolveEndpointFromBlob(blob, null, null, ref({ upstreamKey: null }))).toBeNull();
    expect(cloudflareAgentBaseUrl({ accountId: 'nope', gatewayId: 'g' }, 'anthropic')).toBeNull();
  });

  it('names models the OpenRouter way only when the gateway forwards to OpenRouter', () => {
    expect(mapAgentModel({ kind: 'cloudflare', upstream: 'anthropic' }, 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(mapAgentModel({ kind: 'cloudflare', upstream: 'openrouter' }, 'claude-haiku-4-5-20251001')).toBe(openRouterModelId('anthropic', 'claude-haiku-4-5-20251001'));
    expect(mapAgentModel({ kind: 'cloudflare', upstream: 'anthropic', models: { 'claude-x': 'alias' } }, 'claude-x')).toBe('alias');
  });

  it('builds the same gateway URL as the decision-call helper', () => {
    expect(cloudflareAgentBaseUrl({ accountId: ACCOUNT, gatewayId: 'buildd' }, 'openrouter'))
      .toBe(jevGatewayBaseURL({ apiToken: 'x'.repeat(24), accountId: ACCOUNT, gatewayId: 'buildd' }));
    expect(CLOUDFLARE_AI_GATEWAY_ROOT).toBe(KIT_GATEWAY_ROOT);
  });

  it('verify sends the gateway header', async () => {
    let seen: Headers | null = null;
    const route = resolveEndpointFromBlob({ kind: 'cloudflare', upstream: 'anthropic', gatewayToken: GW_TOKEN }, null, null, ref())!;
    await verifyAgentEndpoint(route, 'claude-haiku-4-5', {
      fetcher: async (_u, init) => { seen = new Headers(init?.headers); return new Response('{}', { status: 200 }); },
      lookup: async () => [{ address: '104.18.0.1', family: 4 }],
    });
    expect(seen!.get('cf-aig-authorization')).toBe(`Bearer ${GW_TOKEN}`);
    expect(seen!.get('x-api-key')).toBe('sk-ant-api03-example');
  });
});
