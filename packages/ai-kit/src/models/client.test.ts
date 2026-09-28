import { describe, expect, it } from 'bun:test';
import {
  createModelsClient, isPlanDeniedError, memoryPlanStore, PlanDeniedError, toCallConfig, gatewayModel, toWireReceipt,
  USAGE_RECORD_KEYS, USAGE_TOKEN_KEYS,
  type ModelsClientEvent, type ModelsClientOptions, type PlanStore, type ResolvedPlan, type UsageReceipt, type WirePlan,
} from './index';

const PLAN_ID = '11111111-2222-4333-8444-555555555555';
const T0 = Date.parse('2026-09-27T12:00:00.000Z');

function wirePlan(over: Partial<WirePlan> = {}, at = T0): WirePlan {
  return {
    planId: PLAN_ID, requestedTier: 'standard', tier: 'standard', surface: 'chat', kind: 'chat_turn',
    provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', source: 'registry', effort: 'medium',
    limits: { maxTurns: null },
    price: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    budget: { action: 'ok', reason: null, remainingUsd: null, dailyCapUsd: null, spentTodayUsd: 0, estimatedCallUsd: 0.0135 },
    ttlSeconds: 60, expiresAt: new Date(at + 60_000).toISOString(), maxStaleSeconds: 86_400,
    ...over,
  };
}

type Handler = (url: string, body: unknown) => Response | Promise<Response> | 'hang' | 'throw';

function harness(handler: Handler, over: Partial<ModelsClientOptions> = {}) {
  let clock = T0;
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const events: ModelsClientEvent[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, headers: init?.headers as Record<string, string> });
    const r = await handler(url, body);
    if (r === 'throw') throw new TypeError('fetch failed');
    if (r === 'hang') return new Promise<Response>(() => {});
    return r;
  };
  const client = createModelsClient({
    baseUrl: 'https://buildd.test/',
    apiKey: 'bld_test',
    providers: ['openrouter'],
    defaults: {
      'premium-plus': { provider: 'openrouter', model: 'anthropic/claude-opus-4.1' },
      premium: { provider: 'openrouter', model: 'anthropic/claude-opus-4.1' },
      standard: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
      budget: { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
    },
    fetch,
    now: () => clock,
    planTimeoutMs: 50,
    usage: { flushIntervalMs: 0, retryDelayMs: 0, timeoutMs: 50 },
    onError: (e) => events.push(e),
    ...over,
  });
  return {
    client, calls, events,
    advance: (ms: number) => { clock += ms; },
    planCalls: () => calls.filter((c) => c.url.endsWith('/api/ai/plan')),
    usageCalls: () => calls.filter((c) => c.url.endsWith('/api/ai/usage')),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('plan: request', () => {
  it('sends only the server-allowed fields, with the app key as bearer', async () => {
    const h = harness(() => json(wirePlan()));
    await h.client.plan({ tier: 'standard', kind: 'chat_turn', budget: { maxUsdPerCall: 0.02 } });
    const [c] = h.planCalls();
    expect(c.url).toBe('https://buildd.test/api/ai/plan');
    expect(c.headers.authorization).toBe('Bearer bld_test');
    expect(c.body).toEqual({ tier: 'standard', surface: 'chat', kind: 'chat_turn', providers: ['openrouter'], budget: { maxUsdPerCall: 0.02 } });
  });

  it('returns the fresh plan with the server source as planSource', async () => {
    const h = harness(() => json(wirePlan({ source: 'pool' })));
    const p = await h.client.plan({ tier: 'standard', kind: 'chat_turn' });
    expect(p).toMatchObject({ planId: PLAN_ID, planSource: 'pool', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', tier: 'standard' });
  });
});

describe('plan: cache TTL', () => {
  it('serves from cache until expiresAt, then asks again', async () => {
    let n = 0;
    const h = harness(() => json(wirePlan({ model: `m-${++n}` }, T0)));
    expect((await h.client.plan({ tier: 'standard', kind: 'a' })).model).toBe('m-1');
    h.advance(59_999);
    expect((await h.client.plan({ tier: 'standard', kind: 'b' })).model).toBe('m-1');
    expect(h.planCalls()).toHaveLength(1);
    h.advance(1);
    expect((await h.client.plan({ tier: 'standard', kind: 'a' })).model).toBe('m-2');
    expect(h.planCalls()).toHaveLength(2);
  });

  it('keys by tier and surface', async () => {
    const h = harness((_, b: any) => json(wirePlan({ tier: b.tier, requestedTier: b.tier, surface: b.surface })));
    await h.client.plan({ tier: 'standard', kind: 'a' });
    await h.client.plan({ tier: 'budget', kind: 'a' });
    await h.client.plan({ tier: 'standard', kind: 'a', surface: 'inference' });
    await h.client.plan({ tier: 'standard', kind: 'a', surface: 'chat' });
    expect(h.planCalls()).toHaveLength(3);
  });

  it('shares one request between concurrent callers', async () => {
    const h = harness(() => json(wirePlan()));
    await Promise.all([1, 2, 3].map(() => h.client.plan({ tier: 'standard', kind: 'a' })));
    expect(h.planCalls()).toHaveLength(1);
  });

  it('reads a persistent store, so a cold start reuses a still-fresh plan', async () => {
    const shared = memoryPlanStore();
    const a = harness(() => json(wirePlan()), { storage: shared });
    await a.client.plan({ tier: 'standard', kind: 'a' });
    const b = harness(() => 'throw', { storage: shared }); // new instance, buildd down
    const p = await b.client.plan({ tier: 'standard', kind: 'a' });
    expect(p.planSource).toBe('registry');
    expect(b.planCalls()).toHaveLength(0);
  });

  it('treats a throwing store as a miss', async () => {
    const broken: PlanStore = { get: () => { throw new Error('kv down'); }, set: async () => { throw new Error('kv down'); } };
    const h = harness(() => json(wirePlan()), { storage: broken });
    expect((await h.client.plan({ tier: 'standard', kind: 'a' })).planSource).toBe('registry');
    expect(h.events.map((e) => e.code)).toEqual(['get_failed', 'set_failed']);
  });
});

describe('plan: stale and fallback', () => {
  const fallbackCases: [string, Handler][] = [
    ['a 5xx', () => json({ error: 'boom' }, 503)],
    ['a network error', () => 'throw'],
    ['a timeout', () => 'hang'],
    ['an unusable body', () => json({ nope: true })],
  ];

  for (const [label, fail] of fallbackCases) {
    it(`serves the last good plan as 'cached' on ${label}`, async () => {
      let down = false;
      const h = harness((u, b) => (down ? fail(u, b) : json(wirePlan())));
      await h.client.plan({ tier: 'standard', kind: 'a' });
      down = true;
      h.advance(61_000);
      const p = await h.client.plan({ tier: 'standard', kind: 'a' });
      expect(p).toMatchObject({ planId: PLAN_ID, planSource: 'cached', model: 'anthropic/claude-sonnet-4.5' });
    });
  }

  it('keeps serving cached up to maxStaleSeconds past expiry, then the fixed default', async () => {
    let down = false;
    const h = harness(() => (down ? json({}, 500) : json(wirePlan())));
    await h.client.plan({ tier: 'standard', kind: 'a' });
    down = true;
    h.advance(60_000 + 86_400_000 - 1);
    expect((await h.client.plan({ tier: 'standard', kind: 'a' })).planSource).toBe('cached');
    h.advance(1);
    const p = await h.client.plan({ tier: 'standard', kind: 'a' });
    expect(p).toMatchObject({ planId: null, planSource: 'fallback', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', tier: 'standard', budget: null });
  });

  it('goes straight to the default when nothing is cached', async () => {
    const h = harness(() => 'throw');
    const p = await h.client.plan({ tier: 'budget', kind: 'a' });
    expect(p).toMatchObject({ planId: null, planSource: 'fallback', model: 'anthropic/claude-haiku-4.5' });
  });

  it('degrades on a 4xx too, and reports it', async () => {
    const h = harness(() => json({ error: 'Unauthorized' }, 401));
    expect((await h.client.plan({ tier: 'standard', kind: 'a' })).planSource).toBe('fallback');
    expect(h.events[0]).toMatchObject({ op: 'plan', code: 'http_401' });
  });

  it('does not reuse a stale deny', async () => {
    let down = false;
    const deny = wirePlan({ provider: null, model: null, budget: { action: 'deny', reason: 'daily_cap_reached', remainingUsd: 0, dailyCapUsd: 5, spentTodayUsd: 5, estimatedCallUsd: null } });
    const h = harness(() => (down ? 'throw' : json(deny)));
    await expect(h.client.plan({ tier: 'standard', kind: 'a' })).rejects.toBeInstanceOf(PlanDeniedError);
    down = true;
    h.advance(61_000);
    expect((await h.client.plan({ tier: 'standard', kind: 'a' })).planSource).toBe('fallback');
  });
});

describe('plan: 800ms deadline', () => {
  it('gives up on buildd at 800ms by default and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const client = createModelsClient({
      apiKey: 'bld_x', providers: ['openrouter'],
      defaults: { 'premium-plus': { provider: 'openrouter', model: 'a' }, premium: { provider: 'openrouter', model: 'b' }, standard: { provider: 'openrouter', model: 'c' }, budget: { provider: 'openrouter', model: 'd' } },
      fetch: (_u, init) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); },
    });
    const t = performance.now();
    const p = await client.plan({ tier: 'standard', kind: 'a' });
    const took = performance.now() - t;
    expect(p.planSource).toBe('fallback');
    expect(took).toBeGreaterThanOrEqual(790);
    expect(took).toBeLessThan(1_500);
    expect(signal?.aborted).toBe(true);
  });
});

describe('plan: budget decisions', () => {
  it('deny throws a typed PlanDeniedError carrying the reason', async () => {
    const h = harness(() => json(wirePlan({ provider: null, model: null, price: null, budget: { action: 'deny', reason: 'per_call_limit', remainingUsd: null, dailyCapUsd: null, spentTodayUsd: 0, estimatedCallUsd: 0.2 } })));
    const err = await h.client.plan({ tier: 'premium', kind: 'a' }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanDeniedError);
    expect(isPlanDeniedError(err)).toBe(true);
    expect(err.reason).toBe('per_call_limit');
    expect(err.code).toBe('plan_denied');
  });

  it('a cached deny keeps denying until it expires', async () => {
    const h = harness(() => json(wirePlan({ provider: null, model: null, budget: { action: 'deny', reason: 'daily_cap_reached', remainingUsd: 0, dailyCapUsd: 1, spentTodayUsd: 1, estimatedCallUsd: null } })));
    await h.client.plan({ tier: 'standard', kind: 'a' }).catch(() => {});
    await expect(h.client.plan({ tier: 'standard', kind: 'a' })).rejects.toBeInstanceOf(PlanDeniedError);
    expect(h.planCalls()).toHaveLength(1);
  });

  it('downgrade returns the cheaper model as buildd sent it', async () => {
    const h = harness(() => json(wirePlan({ tier: 'budget', model: 'anthropic/claude-haiku-4.5', budget: { action: 'downgrade', reason: 'daily_cap_near', remainingUsd: 0.5, dailyCapUsd: 5, spentTodayUsd: 4.5, estimatedCallUsd: 0.0045 } })));
    const p = await h.client.plan({ tier: 'standard', kind: 'a' });
    expect(p).toMatchObject({ requestedTier: 'standard', tier: 'budget', model: 'anthropic/claude-haiku-4.5', planSource: 'registry' });
    expect(p.budget?.action).toBe('downgrade');
  });

  it('rejects a plan routed to a provider the app does not hold', async () => {
    const h = harness(() => json(wirePlan({ provider: 'anthropic', model: 'claude-sonnet-4-5' })));
    expect((await h.client.plan({ tier: 'standard', kind: 'a' })).planSource).toBe('fallback');
  });
});

describe('createModelsClient: config', () => {
  const base = { apiKey: 'bld_x', providers: ['openrouter'] as const };
  it('requires a default for every tier on a held provider', () => {
    expect(() => createModelsClient({ ...base, defaults: { standard: { provider: 'openrouter', model: 'x' } } as any })).toThrow(/defaults\.premium-plus/);
    expect(() => createModelsClient({ ...base, defaults: {
      'premium-plus': { provider: 'anthropic', model: 'x' }, premium: { provider: 'openrouter', model: 'x' },
      standard: { provider: 'openrouter', model: 'x' }, budget: { provider: 'openrouter', model: 'x' },
    } })).toThrow(/not in providers/);
  });
});

// ── receipts ─────────────────────────────────────────────────────────────────

const freshPlan: ResolvedPlan = {
  planId: PLAN_ID, planSource: 'registry', requestedTier: 'standard', tier: 'standard', surface: 'chat', kind: 'a',
  provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', effort: 'medium', limits: { maxTurns: null },
  price: null, budget: null, expiresAt: new Date(T0).toISOString(),
};
const receipt = (over: Partial<UsageReceipt> = {}): UsageReceipt => ({
  plan: freshPlan, tokens: { input: 1200, output: 300 }, costUsd: 0.0031, latencyMs: 850, outcome: 'ok', ...over,
});
const accepted = (b: any) => json({ accepted: b.records.length, rejected: [] });

describe('recordUsage: allowlist', () => {
  it('never sends a field outside the allowlist, whatever the app passes', async () => {
    const h = harness((_, b) => accepted(b));
    const leaky = {
      ...receipt({ feedback: 'up' }),
      prompt: 'secret', messages: [{ role: 'user', content: 'hi' }], subject: 'user_42', userId: 'u1',
      plan: { ...freshPlan, content: 'x', subject: 'user_42' },
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 99 },
    } as unknown as UsageReceipt;
    h.client.recordUsage(leaky);
    await h.client.flush();
    const [rec] = h.usageCalls()[0].body.records;
    expect(Object.keys(h.usageCalls()[0].body)).toEqual(['records']);
    for (const k of Object.keys(rec)) expect(USAGE_RECORD_KEYS as readonly string[]).toContain(k);
    for (const k of Object.keys(rec.tokens)) expect(USAGE_TOKEN_KEYS as readonly string[]).toContain(k);
    expect(JSON.stringify(h.usageCalls()[0].body)).not.toMatch(/secret|user_42|content|reasoning/);
    expect(rec).toEqual({
      planId: PLAN_ID, model: 'anthropic/claude-sonnet-4.5', provider: 'openrouter', tier: 'standard', planSource: 'registry',
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: 0.0031, latencyMs: 850, outcome: 'ok', feedback: 'up',
    });
  });

  it('fallback receipts carry planId null plus model, provider and tier', async () => {
    const h = harness((u, b) => (u.endsWith('/plan') ? 'throw' : accepted(b)));
    const plan = await h.client.plan({ tier: 'budget', kind: 'a' });
    h.client.recordUsage(receipt({ plan }));
    await h.client.flush();
    expect(h.usageCalls()[0].body.records[0]).toMatchObject({ planId: null, planSource: 'fallback', model: 'anthropic/claude-haiku-4.5', provider: 'openrouter', tier: 'budget' });
  });

  it('refuses locally, and counts, what buildd would reject, so one bad record cannot sink a batch', async () => {
    const h = harness((_, b) => accepted(b));
    h.client.recordUsage(receipt({ latencyMs: -1 }));
    h.client.recordUsage(receipt({ tokens: { input: Number.NaN, output: 1 } }));
    h.client.recordUsage(receipt({ plan: { ...freshPlan, model: 'has spaces in it' } }));
    h.client.recordUsage(receipt({ plan: { ...freshPlan, planId: 'not-a-uuid' } }));
    h.client.recordUsage(receipt());
    await h.client.flush();
    expect(h.client.stats()).toMatchObject({ invalid: 4, sent: 1, dropped: 0 });
    expect(h.usageCalls()[0].body.records).toHaveLength(1);
  });

  it('rounds fractional counts to integers', () => {
    const w = toWireReceipt(receipt({ latencyMs: 850.6, tokens: { input: 10.4, output: 2.5 } }));
    expect(w.ok && w.record).toMatchObject({ latencyMs: 851, tokens: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0 } });
  });
});

describe('recordUsage: batching, retry, drop', () => {
  it('batches at most 100 records per request', async () => {
    const h = harness((_, b) => accepted(b));
    for (let i = 0; i < 250; i++) h.client.recordUsage(receipt());
    await h.client.flush();
    expect(h.usageCalls().map((c) => c.body.records.length)).toEqual([100, 100, 50]);
    expect(h.client.stats()).toMatchObject({ sent: 250, queued: 0, dropped: 0 });
  });

  it('auto-flushes after the interval', async () => {
    const h = harness((_, b) => accepted(b), { usage: { flushIntervalMs: 5, retryDelayMs: 0 } });
    h.client.recordUsage(receipt());
    h.client.recordUsage(receipt());
    expect(h.usageCalls()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.usageCalls()).toHaveLength(1);
    expect(h.usageCalls()[0].body.records).toHaveLength(2);
  });

  it('retries a failed batch once, then succeeds', async () => {
    let n = 0;
    const h = harness((_, b) => (++n === 1 ? json({}, 503) : accepted(b)));
    h.client.recordUsage(receipt());
    await h.client.flush();
    expect(h.usageCalls()).toHaveLength(2);
    expect(h.client.stats()).toMatchObject({ sent: 1, dropped: 0 });
  });

  it('drops and counts after the single retry; never throws', async () => {
    const h = harness(() => 'throw');
    h.client.recordUsage(receipt());
    h.client.recordUsage(receipt());
    await expect(h.client.flush()).resolves.toBeUndefined();
    expect(h.usageCalls()).toHaveLength(2);
    expect(h.client.stats()).toMatchObject({ sent: 0, dropped: 2, queued: 0 });
  });

  it('times out a hung usage request, retries once, then drops', async () => {
    const h = harness(() => 'hang');
    h.client.recordUsage(receipt());
    await h.client.flush();
    expect(h.usageCalls()).toHaveLength(2);
    expect(h.client.stats().dropped).toBe(1);
  });

  it('does not retry a 4xx (it would fail the same way)', async () => {
    const h = harness(() => json({ error: 'unknown field(s)' }, 400));
    h.client.recordUsage(receipt());
    await h.client.flush();
    expect(h.usageCalls()).toHaveLength(1);
    expect(h.client.stats().dropped).toBe(1);
  });

  it('counts per-record rejections from buildd', async () => {
    const h = harness(() => json({ accepted: 1, rejected: [{ index: 1, reason: 'unknown_plan' }] }));
    h.client.recordUsage(receipt());
    h.client.recordUsage(receipt());
    await h.client.flush();
    expect(h.client.stats()).toMatchObject({ sent: 1, rejected: 1 });
  });

  it('drops past maxQueue instead of growing without bound', async () => {
    const h = harness(() => 'throw', { usage: { flushIntervalMs: 0, maxBatch: 100, maxQueue: 100, retryDelayMs: 0, timeoutMs: 50 } });
    for (let i = 0; i < 99; i++) h.client.recordUsage(receipt());
    expect(h.client.stats().queued).toBe(99);
    h.client.recordUsage(receipt()); // 100th triggers a flush of the full batch
    await h.client.flush();
    expect(h.client.stats()).toMatchObject({ dropped: 100, queued: 0 });
  });

  it('a malformed receipt never throws into the app', () => {
    const h = harness(() => json({}));
    expect(() => h.client.recordUsage(null as unknown as UsageReceipt)).not.toThrow();
    expect(() => h.client.recordUsage({} as UsageReceipt)).not.toThrow();
    expect(h.client.stats().invalid).toBe(2);
  });
});

describe('toCallConfig', () => {
  it('builds an OpenRouter config with attribution and cost accounting', () => {
    const cfg = toCallConfig(freshPlan, { apiKeys: { openrouter: 'sk-or' }, appName: 'cue', appUrl: 'https://cue.app' });
    expect(cfg).toEqual({
      provider: 'openrouter', via: 'direct', model: 'anthropic/claude-sonnet-4.5', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or',
      headers: { 'X-Title': 'cue', 'HTTP-Referer': 'https://cue.app' }, extraBody: { usage: { include: true } },
      effort: 'medium', maxTurns: null,
    });
  });

  it('builds an Anthropic config', () => {
    const cfg = toCallConfig({ ...freshPlan, provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(cfg).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-5', baseURL: 'https://api.anthropic.com/v1', apiKey: undefined, headers: { 'anthropic-version': '2023-06-01' }, extraBody: {} });
  });

  it('routes through a LiteLLM gateway: provider/model id, gateway URL and key, no provider headers', () => {
    const plan = { ...freshPlan, provider: 'anthropic' as const, model: 'claude-sonnet-5' };
    const cfg = toCallConfig(plan, { apiKeys: { anthropic: 'sk-ant' }, gateway: { kind: 'litellm', baseURL: 'https://litellm.example.test/v1/', apiKey: 'sk-lite' } });
    expect(cfg).toEqual({
      provider: 'anthropic', via: 'litellm', model: 'anthropic/claude-sonnet-5', baseURL: 'https://litellm.example.test/v1',
      apiKey: 'sk-lite', headers: {}, extraBody: {}, effort: 'medium', maxTurns: null,
    });
  });

  it('maps a plan to the gateway\'s own alias, qualified first, or sends the bare id', () => {
    const base = { kind: 'litellm' as const, baseURL: 'https://litellm.example.test/v1' };
    expect(gatewayModel({ ...base, models: { 'openai/gpt-5': 'house-gpt', 'gpt-5': 'bare' } }, 'openai', 'gpt-5')).toBe('house-gpt');
    expect(gatewayModel({ ...base, models: { 'gpt-5': 'bare' } }, 'openai', 'gpt-5')).toBe('bare');
    expect(gatewayModel({ ...base, prefix: false }, 'openai', 'gpt-5')).toBe('gpt-5');
    expect(gatewayModel(base, 'openrouter', 'qwen/qwen3-8b')).toBe('openrouter/qwen/qwen3-8b');
  });

  it('refuses a gateway with no base URL', () => {
    expect(() => toCallConfig(freshPlan, { gateway: { kind: 'litellm', baseURL: '' } })).toThrow(/baseURL/);
  });
});
