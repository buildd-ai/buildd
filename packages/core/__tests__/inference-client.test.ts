import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * The inference primitive.
 *
 * Every server-side LLM call in buildd used to be a hand-rolled fetch to
 * api.anthropic.com keyed on `process.env.ANTHROPIC_API_KEY` — a var that is not
 * set in production. Four sites, four model resolvers, three fence-stripping
 * regexes, four failure modes, and no way for a team to point them at a different
 * provider. This client is the one path: callers name a tier, the team's registry
 * names the provider, and the key comes from `secrets`.
 */

let tierEntry: any = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', source: 'default' };
let secretRows: any[] = [];
let teamRow: any = { chatDisabled: false, inferenceFeatureModes: null };

const mockResolveTierEntry = mock(() => Promise.resolve(tierEntry));

mock.module('../db', () => ({
  db: {
    query: {
      secrets: { findMany: () => Promise.resolve(secretRows) },
      teams: { findFirst: () => Promise.resolve(teamRow) },
    },
  },
}));

mock.module('../db/schema', () => ({
  teams: { id: 'id', chatDisabled: 'chat_disabled', inferenceFeatureModes: 'inference_feature_modes' },
  secrets: {
    id: 'id', teamId: 'team_id', purpose: 'purpose', label: 'label',
    encryptedValue: 'encrypted_value', workspaceId: 'workspace_id',
    healthStatus: 'health_status', updatedAt: 'updated_at',
  },
}));

mock.module('../secrets', () => ({
  decrypt: (s: string) => {
    if (s === 'enc:BROKEN') throw new Error('bad key');
    return s.replace(/^enc:/, '');
  },
}));

mock.module('../model-tier-registry', () => ({
  resolveTierEntry: mockResolveTierEntry,
}));

mock.module('drizzle-orm', () => ({
  and: (...c: any[]) => ({ __and: c }),
  eq: (f: any, v: any) => ({ __eq: [f, v] }),
  or: (...c: any[]) => ({ __or: c }),
  isNull: (f: any) => ({ __isNull: f }),
  sql: (s: any) => ({ __sql: s }),
}));

const {
  inferenceCall,
  resolveInferenceKey,
  extractJson,
  describeInferenceError,
  INFERENCE_KEY_PURPOSE,
} = await import('../inference-client');

const { createPublicGatewayFetcher } = await import('../net/fetch-public-gateway');

// ── helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** An Anthropic /v1/messages reply carrying `text`. */
function anthropicReply(text: string, usage = { input_tokens: 11, output_tokens: 22 }) {
  return jsonResponse({ content: [{ type: 'text', text }], usage });
}

/** An OpenRouter chat-completions reply carrying `text`. */
function openRouterReply(text: string, usage = { prompt_tokens: 33, completion_tokens: 44 }) {
  return jsonResponse({ choices: [{ message: { content: text } }], usage });
}

function secretRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    purpose: INFERENCE_KEY_PURPOSE,
    label: 'anthropic',
    encryptedValue: 'enc:key-inference',
    workspaceId: null,
    healthStatus: 'healthy',
    updatedAt: new Date('2026-08-01'),
    ...overrides,
  };
}

const VALIDATE_VERDICTS = (parsed: unknown) => {
  const v = (parsed as any)?.verdicts;
  return Array.isArray(v) ? { verdicts: v } : null;
};

const noSleep = () => Promise.resolve();

function baseParams(over: Record<string, unknown> = {}) {
  return {
    capability: 'criteria_grading' as const,
    tier: 'budget' as const,
    teamId: 'team-1',
    system: 'sys',
    user: 'usr',
    validate: VALIDATE_VERDICTS,
    sleep: noSleep,
    ...over,
  };
}

beforeEach(() => {
  tierEntry = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', source: 'default' };
  secretRows = [secretRow()];
  teamRow = { chatDisabled: false, inferenceFeatureModes: null };
  mockResolveTierEntry.mockClear();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

// ── extractJson ───────────────────────────────────────────────────────────────

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a fenced json block', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```\n')).toEqual({ a: 1 });
  });

  it('parses an unlabelled fenced block', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses an object followed by prose', () => {
    // The old `/\{[\s\S]*\}/` regex was greedy and swallowed the trailing text,
    // then failed to parse — every site had a variant of this bug.
    expect(extractJson('{"a":1}\n\nHope that helps!')).toEqual({ a: 1 });
  });

  it('parses an object preceded by prose', () => {
    expect(extractJson('Here you go: {"a":1}')).toEqual({ a: 1 });
  });

  it('handles nested braces and braces inside strings', () => {
    expect(extractJson('note {"a":{"b":2},"c":"}{"} end')).toEqual({ a: { b: 2 }, c: '}{' });
  });

  it('handles an escaped quote inside a string', () => {
    expect(extractJson('{"a":"say \\"hi\\""}')).toEqual({ a: 'say "hi"' });
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJson('I cannot help with that.')).toBeNull();
    expect(extractJson('')).toBeNull();
  });

  it('returns null on an unterminated object', () => {
    expect(extractJson('{"a":1')).toBeNull();
  });
});

// ── resolveInferenceKey ───────────────────────────────────────────────────────

describe('resolveInferenceKey', () => {
  it('finds an inference_key row matching the provider label', async () => {
    const key = await resolveInferenceKey({ provider: 'anthropic', teamId: 'team-1' });
    expect(key).toBe('key-inference');
  });

  it('ignores an inference_key row labelled for a different provider', async () => {
    secretRows = [secretRow({ label: 'openrouter', encryptedValue: 'enc:key-or' })];
    // A label mismatch means this key belongs to another provider; sending it to
    // Anthropic would leak one provider's credential to another.
    expect(await resolveInferenceKey({ provider: 'anthropic', teamId: 'team-1' })).toBeNull();
  });

  it('matches the provider label case-insensitively', async () => {
    secretRows = [secretRow({ label: 'OpenRouter', encryptedValue: 'enc:key-or' })];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 'team-1' })).toBe('key-or');
  });

  it('accepts an existing anthropic_api_key row for Anthropic', async () => {
    secretRows = [secretRow({ purpose: 'anthropic_api_key', label: null, encryptedValue: 'enc:sk-ant' })];
    // A team that already pasted a key for worker runs should not have to paste it
    // a second time to enable judgments.
    expect(await resolveInferenceKey({ provider: 'anthropic', teamId: 'team-1' })).toBe('sk-ant');
  });

  it('never uses an anthropic_api_key row for OpenRouter', async () => {
    secretRows = [secretRow({ purpose: 'anthropic_api_key', label: null, encryptedValue: 'enc:sk-ant' })];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 'team-1' })).toBeNull();
  });

  it('prefers an inference_key over an anthropic_api_key', async () => {
    secretRows = [
      secretRow({ purpose: 'anthropic_api_key', label: null, encryptedValue: 'enc:sk-old' }),
      secretRow({ purpose: INFERENCE_KEY_PURPOSE, label: 'anthropic', encryptedValue: 'enc:sk-new' }),
    ];
    expect(await resolveInferenceKey({ provider: 'anthropic', teamId: 'team-1' })).toBe('sk-new');
  });

  it('prefers a workspace-scoped key over the team-wide one', async () => {
    secretRows = [
      secretRow({ id: 's-team', workspaceId: null, encryptedValue: 'enc:team-key' }),
      secretRow({ id: 's-ws', workspaceId: 'ws-1', encryptedValue: 'enc:ws-key' }),
    ];
    const key = await resolveInferenceKey({ provider: 'anthropic', teamId: 'team-1', workspaceId: 'ws-1' });
    expect(key).toBe('ws-key');
  });

  it('does not let a revoked row shadow a healthy one', async () => {
    secretRows = [
      secretRow({ id: 's-dead', healthStatus: 'revoked', encryptedValue: 'enc:dead', updatedAt: new Date('2026-08-20') }),
      secretRow({ id: 's-live', healthStatus: 'healthy', encryptedValue: 'enc:live', updatedAt: new Date('2026-08-01') }),
    ];
    expect(await resolveInferenceKey({ provider: 'anthropic', teamId: 'team-1' })).toBe('live');
  });

  it('falls back to the provider env var when no row exists', async () => {
    secretRows = [];
    process.env.ANTHROPIC_API_KEY = 'env-anthropic';
    process.env.OPENROUTER_API_KEY = 'env-openrouter';
    expect(await resolveInferenceKey({ provider: 'anthropic', teamId: 'team-1' })).toBe('env-anthropic');
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 'team-1' })).toBe('env-openrouter');
  });

  it('falls back to env when the stored row cannot be decrypted', async () => {
    secretRows = [secretRow({ encryptedValue: 'enc:BROKEN' })];
    process.env.ANTHROPIC_API_KEY = 'env-anthropic';
    expect(await resolveInferenceKey({ provider: 'anthropic', teamId: 'team-1' })).toBe('env-anthropic');
  });

  it('returns null when there is neither a row nor an env var', async () => {
    secretRows = [];
    expect(await resolveInferenceKey({ provider: 'anthropic', teamId: 'team-1' })).toBeNull();
  });
});

// ── Provider routing ──────────────────────────────────────────────────────────

describe('inferenceCall — provider routing', () => {
  it('calls Anthropic with x-api-key when the tier says anthropic', async () => {
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[1]}'))) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.provider).toBe('anthropic');
    expect(res.model).toBe('claude-haiku-4-5-20251001');
    expect(res.data).toEqual({ verdicts: [1] });
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 22 });

    const [url, init] = fetcher.mock.calls[0] as any[];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('key-inference');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.system).toBe('sys');
  });

  it('calls OpenRouter with a Bearer token when the tier says openrouter', async () => {
    // The whole point: a team switches provider by editing a tier row, with no
    // change at any call site.
    tierEntry = { provider: 'openrouter', model: 'anthropic/claude-3.7-sonnet', source: 'team' };
    secretRows = [secretRow({ label: 'openrouter', encryptedValue: 'enc:or-key' })];
    const fetcher = mock(() => Promise.resolve(openRouterReply('{"verdicts":[2]}'))) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.provider).toBe('openrouter');
    expect(res.model).toBe('anthropic/claude-3.7-sonnet');
    expect(res.data).toEqual({ verdicts: [2] });
    expect(res.usage).toEqual({ inputTokens: 33, outputTokens: 44 });

    const [url, init] = fetcher.mock.calls[0] as any[];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers['authorization']).toBe('Bearer or-key');
    expect(init.headers['x-api-key']).toBeUndefined();
    const body = JSON.parse(init.body);
    // OpenAI-compatible shape: system becomes a message, not a top-level field.
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'usr' });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('sends attribution headers to OpenRouter', async () => {
    tierEntry = { provider: 'openrouter', model: 'x/y', source: 'team' };
    secretRows = [secretRow({ label: 'openrouter', encryptedValue: 'enc:or-key' })];
    const fetcher = mock(() => Promise.resolve(openRouterReply('{"verdicts":[]}'))) as any;

    await inferenceCall(baseParams({ fetcher }));

    const [, init] = fetcher.mock.calls[0] as any[];
    // Without these the team's OpenRouter dashboard shows anonymous traffic.
    expect(init.headers['http-referer']).toBe('https://buildd.dev');
    expect(init.headers['x-title']).toBe('buildd');
  });

  it('resolves the tier for the caller team and workspace', async () => {
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[]}'))) as any;
    await inferenceCall(baseParams({ fetcher, workspaceId: 'ws-9' }));
    expect(mockResolveTierEntry).toHaveBeenCalledWith('budget', 'team-1', 'ws-9', 'chat');
  });

  it('refuses a provider that cannot serve single-shot calls', async () => {
    tierEntry = { provider: 'openai-codex', model: 'gpt-5-codex', source: 'team' };
    const fetcher = mock(() => Promise.resolve(anthropicReply('{}'))) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Codex is an agent backend driving a CLI session, not a structured endpoint.
    expect(res.error).toEqual({ kind: 'unsupported_provider', provider: 'openai-codex' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// ── LiteLLM gateway fallback ──────────────────────────────────────────────────

describe('inferenceCall through the team LiteLLM gateway', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const gatewayRow = () => secretRow({
    id: 's-gw', label: 'litellm',
    encryptedValue: `enc:${JSON.stringify({ apiKey: 'sk-lite', baseUrl: 'https://litellm.example.test/v1' })}`,
  });
  const chatReply = (text: string) => new Response(JSON.stringify({
    choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('serves the tier model as provider/model when the provider has no key', async () => {
    secretRows = [gatewayRow()];
    const calls: Array<{ url: string; init: any }> = [];
    const fetcherMock = mock((url: string, init: any) => { calls.push({ url, init }); return Promise.resolve(chatReply('{"verdicts":[]}')); }) as any;
    const gatewayFetcher = createPublicGatewayFetcher({ lookup: publicLookup as any, fetcher: fetcherMock });
    const res = await inferenceCall(baseParams({ gatewayFetcher }));
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe('https://litellm.example.test/v1/chat/completions');
    expect(calls[0].init.headers.authorization).toBe('Bearer sk-lite');
    expect(calls[0].init.headers['x-title']).toBeUndefined();
    expect(JSON.parse(calls[0].init.body).model).toBe('anthropic/claude-haiku-4-5-20251001');
    expect(res.ok && res.provider).toBe('anthropic');
  });

  it('prefers the provider key over the gateway', async () => {
    secretRows = [secretRow(), gatewayRow()];
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[]}'))) as any;
    await inferenceCall(baseParams({ fetcher }));
    expect((fetcher.mock.calls[0] as any[])[0]).toContain('api.anthropic.com');
  });

  it('serves an OpenAI tier through the gateway when there is no OpenAI or OpenRouter key', async () => {
    tierEntry = { provider: 'openai', model: 'gpt-5.6-terra', source: 'team' };
    secretRows = [gatewayRow()];
    const fetcherMock = mock(() => Promise.resolve(chatReply('{"verdicts":[]}'))) as any;
    const gatewayFetcher = createPublicGatewayFetcher({ lookup: publicLookup as any, fetcher: fetcherMock });
    const res = await inferenceCall(baseParams({ gatewayFetcher }));
    expect(res.ok && res.route).toBe('litellm');
    secretRows = [];
    const none = await inferenceCall(baseParams({ fetcher: fetcherMock }));
    expect(!none.ok && none.error).toEqual({ kind: 'missing_key', provider: 'openai' });
  });

  it('refuses to call a gateway that resolves to a private address', async () => {
    secretRows = [{
      ...gatewayRow(),
      encryptedValue: `enc:${JSON.stringify({ apiKey: 'sk-lite', baseUrl: 'https://private.example.test/v1' })}`,
    }];
    // Even though the hostname looks valid at save time, if it resolves to a private
    // address at call time (e.g. due to DNS hijacking), the call is refused.
    const privateAddrLookup = async () => [{ address: '192.168.1.1', family: 4 }];
    const gatewayFetcher = createPublicGatewayFetcher({ lookup: privateAddrLookup as any });
    const res = await inferenceCall(baseParams({ gatewayFetcher }));
    expect(!res.ok && res.error).toEqual({ kind: 'transport', message: expect.stringContaining('not a public address') });
  });

  it('refuses a redirect response from the gateway', async () => {
    secretRows = [gatewayRow()];
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const fetcher = mock(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } });
    }) as any;
    const gatewayFetcher = createPublicGatewayFetcher({ lookup: publicLookup as any, fetcher });
    const res = await inferenceCall(baseParams({ gatewayFetcher }));
    expect(!res.ok && res.error).toEqual({ kind: 'transport', message: expect.stringContaining('redirect') });
  });
});

// ── One route order: own API → OpenRouter → gateway ───────────────────────────

describe('inferenceCall route order', () => {
  it('calls OpenAI directly with its own key', async () => {
    tierEntry = { provider: 'openai', model: 'gpt-5.6-terra', source: 'team' };
    secretRows = [secretRow({ label: 'openai', encryptedValue: 'enc:sk-oa' })];
    const fetcher = mock(() => Promise.resolve(openRouterReply('{"verdicts":[]}'))) as any;
    const res = await inferenceCall(baseParams({ fetcher }));
    const [url, init] = fetcher.mock.calls[0] as any[];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer sk-oa');
    expect(init.headers['x-title']).toBeUndefined();
    expect(JSON.parse(init.body).model).toBe('gpt-5.6-terra');
    expect(res.ok && res.route).toBe('openai');
  });

  it('serves an Anthropic tier through OpenRouter when that is the only key', async () => {
    secretRows = [secretRow({ label: 'openrouter', encryptedValue: 'enc:or-key' })];
    const fetcher = mock(() => Promise.resolve(openRouterReply('{"verdicts":[]}'))) as any;
    const res = await inferenceCall(baseParams({ fetcher }));
    const [url, init] = fetcher.mock.calls[0] as any[];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers['x-title']).toBe('buildd');
    expect(JSON.parse(init.body).model).toBe('anthropic/claude-haiku-4.5');
    // The receipt still names the planned vendor and model, so it is priced as itself.
    expect(res.ok && [res.provider, res.model, res.route]).toEqual(['anthropic', 'claude-haiku-4-5-20251001', 'openrouter']);
  });

  it('prefers OpenRouter over the gateway', async () => {
    secretRows = [
      secretRow({ label: 'openrouter', encryptedValue: 'enc:or-key' }),
      secretRow({ id: 's-gw', label: 'litellm', encryptedValue: `enc:${JSON.stringify({ apiKey: 'sk-lite', baseUrl: 'https://litellm.example.test/v1' })}` }),
    ];
    const fetcher = mock(() => Promise.resolve(openRouterReply('{"verdicts":[]}'))) as any;
    const res = await inferenceCall(baseParams({ fetcher }));
    expect((fetcher.mock.calls[0] as any[])[0]).toContain('openrouter.ai');
    expect(res.ok && res.route).toBe('openrouter');
  });
});

// ── Multimodal ────────────────────────────────────────────────────────────────

describe('inferenceCall — multimodal', () => {
  it('sends a base64 image as an Anthropic image block before the text', async () => {
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[]}'))) as any;

    await inferenceCall(baseParams({ fetcher, imageB64: 'AAAA' }));

    const body = JSON.parse((fetcher.mock.calls[0] as any[])[1].body);
    expect(body.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: 'usr' });
  });

  it('sends a base64 image as an OpenRouter data-URI image_url part', async () => {
    tierEntry = { provider: 'openrouter', model: 'x/y', source: 'team' };
    secretRows = [secretRow({ label: 'openrouter', encryptedValue: 'enc:or-key' })];
    const fetcher = mock(() => Promise.resolve(openRouterReply('{"verdicts":[]}'))) as any;

    await inferenceCall(baseParams({ fetcher, imageB64: 'AAAA' }));

    const body = JSON.parse((fetcher.mock.calls[0] as any[])[1].body);
    expect(body.messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
  });
});

// ── Failure taxonomy ──────────────────────────────────────────────────────────

describe('inferenceCall — failure taxonomy', () => {
  it('reports missing_key without calling the provider', async () => {
    secretRows = [];
    const fetcher = mock(() => Promise.resolve(anthropicReply('{}'))) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'missing_key', provider: 'anthropic' });
    // Eager check: no point paying a round-trip to learn we have no credential.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('names the provider in missing_key so the operator knows which key to add', async () => {
    tierEntry = { provider: 'openrouter', model: 'x/y', source: 'team' };
    secretRows = [];
    const res = await inferenceCall(baseParams({ fetcher: mock(() => Promise.resolve(anthropicReply('{}'))) as any }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'missing_key', provider: 'openrouter' });
  });

  it('reports provider_error with the status on a 4xx', async () => {
    const fetcher = mock(() => Promise.resolve(new Response('bad request', { status: 400 }))) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_error');
    if (res.error.kind !== 'provider_error') return;
    expect(res.error.status).toBe(400);
    // A 4xx is our fault and will not fix itself — one attempt only.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports rate_limited with retryAfter on a 429', async () => {
    const fetcher = mock(() => Promise.resolve(
      new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
    )) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'rate_limited', retryAfter: 30 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports transport when the fetch throws', async () => {
    const fetcher = mock(() => Promise.reject(new Error('ECONNRESET'))) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('transport');
  });

  it('reports parse and keeps the raw text when the response is not JSON', async () => {
    const fetcher = mock(() => Promise.resolve(anthropicReply('I would rather not.'))) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('parse');
    if (res.error.kind !== 'parse') return;
    // The raw text is the only way to debug a model that went off-format.
    expect(res.error.raw).toContain('I would rather not');
  });

  it('reports parse when the JSON is well-formed but fails validation', async () => {
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"wrong":"shape"}'))) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('parse');
  });

  it('describes every error kind in one line', () => {
    expect(describeInferenceError({ kind: 'missing_key', provider: 'openrouter' })).toContain('openrouter');
    expect(describeInferenceError({ kind: 'unsupported_provider', provider: 'openai-codex' })).toContain('openai-codex');
    expect(describeInferenceError({ kind: 'transport', message: 'boom' })).toContain('boom');
    expect(describeInferenceError({ kind: 'provider_error', status: 500, body: '' })).toContain('500');
    expect(describeInferenceError({ kind: 'rate_limited' })).toContain('rate-limited');
    expect(describeInferenceError({ kind: 'parse', raw: '' })).toContain('parsed');
  });
});

// ── Retry contract ────────────────────────────────────────────────────────────

describe('inferenceCall — retry', () => {
  it('retries once on a 5xx and succeeds', async () => {
    let n = 0;
    const fetcher = mock(() => {
      n++;
      return Promise.resolve(n === 1
        ? new Response('boom', { status: 503 })
        : anthropicReply('{"verdicts":[7]}'));
    }) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ verdicts: [7] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries once on a transport error and succeeds', async () => {
    let n = 0;
    const fetcher = mock(() => {
      n++;
      return n === 1
        ? Promise.reject(new Error('ECONNRESET'))
        : Promise.resolve(anthropicReply('{"verdicts":[]}'));
    }) as any;

    const res = await inferenceCall(baseParams({ fetcher }));
    expect(res.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('gives up after exactly one retry', async () => {
    const fetcher = mock(() => Promise.resolve(new Response('boom', { status: 500 }))) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(false);
    // Bounded: a judgment is not worth an unbounded retry budget.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry a parse failure', async () => {
    const fetcher = mock(() => Promise.resolve(anthropicReply('nope'))) as any;
    await inferenceCall(baseParams({ fetcher }));
    // The model answered; asking again with the same prompt is not a fix.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('backs off between attempts', async () => {
    const slept: number[] = [];
    const fetcher = mock(() => Promise.resolve(new Response('boom', { status: 500 }))) as any;

    await inferenceCall(baseParams({
      fetcher,
      sleep: (ms: number) => { slept.push(ms); return Promise.resolve(); },
    }));

    expect(slept).toEqual([1000]);
  });
});

// ── Token budget ──────────────────────────────────────────────────────────────

describe('inferenceCall — maxTokens', () => {
  it('defaults to 1024', async () => {
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[]}'))) as any;
    await inferenceCall(baseParams({ fetcher }));
    expect(JSON.parse((fetcher.mock.calls[0] as any[])[1].body).max_tokens).toBe(1024);
  });

  it('honours an explicit maxTokens', async () => {
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[]}'))) as any;
    await inferenceCall(baseParams({ fetcher, maxTokens: 4096 }));
    expect(JSON.parse((fetcher.mock.calls[0] as any[])[1].body).max_tokens).toBe(4096);
  });
});

// ── Model-tier ceiling ────────────────────────────────────────────────────────

describe('inferenceCall — model-tier ceiling (team/workspace layers; a feature is not a person)', () => {
  it('a premium feature call is served at the team ceiling', async () => {
    teamRow = { chatDisabled: false, inferenceFeatureModes: null, modelTierCeilings: { team: { chat: 'standard' } } };
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[3]}'))) as any;
    const res = await inferenceCall(baseParams({ fetcher, tier: 'premium' }));
    expect(res.ok).toBe(true);
    expect((mockResolveTierEntry.mock.calls.at(-1) as any[])[0]).toBe('standard');
  });

  it("with overCapAuto 'deny' the call is refused before spending", async () => {
    teamRow = { chatDisabled: false, inferenceFeatureModes: null, modelTierCeilings: { team: { all: 'budget' }, overCapAuto: 'deny' } };
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[]}'))) as any;
    const res = await inferenceCall(baseParams({ fetcher, tier: 'standard' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ kind: 'policy_denied', tier: 'standard', maxTier: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a coding-agent-only cap and an unrelated workspace cap leave inference alone', async () => {
    teamRow = { chatDisabled: false, inferenceFeatureModes: null, modelTierCeilings: { team: { agent: 'budget' }, workspaces: { 'other-ws': { all: 'budget' } } } };
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[3]}'))) as any;
    await inferenceCall(baseParams({ fetcher, tier: 'premium' }));
    expect((mockResolveTierEntry.mock.calls.at(-1) as any[])[0]).toBe('premium');
  });
});

// ── Capability policy ─────────────────────────────────────────────────────────

describe('inferenceCall — capability policy', () => {
  it('refuses before spending when an admin sent the feature to the runner', async () => {
    teamRow = { chatDisabled: false, inferenceFeatureModes: { criteria_grading: 'runner' } };
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[]}'))) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'capability_disabled', capability: 'criteria_grading' });
    // Checked ahead of tier resolution and the provider call: a disabled
    // capability should cost one cheap query, not a round trip.
    expect(fetcher).not.toHaveBeenCalled();
    expect(mockResolveTierEntry).not.toHaveBeenCalled();
  });

  it('runs server-side by default: a team that never touched a setting and holds a key spends it', async () => {
    teamRow = { chatDisabled: false, inferenceFeatureModes: null };
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[3]}'))) as any;
    const res = await inferenceCall(baseParams({ fetcher }));
    expect(res.ok).toBe(true);
  });

  it('refuses when the team row is missing', async () => {
    teamRow = undefined;
    const res = await inferenceCall(baseParams({ fetcher: mock(() => Promise.resolve(anthropicReply('{}'))) as any }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('capability_disabled');
  });

  it('an override for another feature leaves this one alone', async () => {
    teamRow = { chatDisabled: false, inferenceFeatureModes: { visual_qa: 'runner' } };
    const fetcher = mock(() => Promise.resolve(anthropicReply('{"verdicts":[3]}'))) as any;

    const res = await inferenceCall(baseParams({ fetcher }));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ verdicts: [3] });
  });

  it('checks the policy before the key, so a feature sent to the runner never reports a missing key', async () => {
    teamRow = { chatDisabled: false, inferenceFeatureModes: { criteria_grading: 'runner' } };
    secretRows = [];

    const res = await inferenceCall(baseParams({ fetcher: mock(() => Promise.resolve(anthropicReply('{}'))) as any }));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('capability_disabled');
  });

  it('describes the disabled error', () => {
    expect(describeInferenceError({ kind: 'capability_disabled', capability: 'visual_qa' })).toContain('visual_qa');
  });
});
