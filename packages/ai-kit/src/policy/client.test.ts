import { describe, expect, it } from 'bun:test';
import { createPolicyClient, remotePolicy, type PolicyClientEvent } from './client';
import { DEFAULT_MODEL_POLICY } from './defaults';
import type { ModelPolicy, OutcomeReport } from './types';

const local: ModelPolicy = {
  version: 'local-1',
  tiers: { standard: { provider: 'anthropic', model: 'local-standard' } },
  surfaces: { coding: { standard: { provider: 'anthropic', model: 'local-coding', effort: 'high' } } },
};

const decision = (over: Record<string, unknown> = {}) => ({
  provider: 'openrouter', model: 'remote-model', effort: 'medium', policyVersion: '42', planId: 'plan-1',
  surface: 'chat', tier: 'standard', source: 'surface', ...over,
});

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const call = { url, init: init ?? {} };
    calls.push(call);
    return answer(call);
  };
  return { fetch, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('local-first', () => {
  it('resolves with no service and no network', async () => {
    const c = createPolicyClient({ policy: local });
    expect(await c.resolve({ surface: 'chat', tier: 'standard' })).toMatchObject({ model: 'local-standard', source: 'tier', planId: null, policyVersion: 'local-1' });
    expect(await c.resolve({ surface: 'coding', tier: 'standard' })).toMatchObject({ model: 'local-coding', effort: 'high', source: 'surface' });
  });

  it('an unset tier falls to the fallback policy', async () => {
    const c = createPolicyClient({ policy: local });
    expect(await c.resolve({ surface: 'chat', tier: 'budget' })).toMatchObject({ ...DEFAULT_MODEL_POLICY.tiers.budget, source: 'bundled' });
    const own = { version: 'own', tiers: { 'premium-plus': { provider: 'openai' as const, model: 'o-pp' }, premium: { provider: 'openai' as const, model: 'o-p' }, standard: { provider: 'openai' as const, model: 'o-s' }, budget: { provider: 'openai' as const, model: 'o-b' } } };
    const c2 = createPolicyClient({ policy: local, fallback: own });
    expect(await c2.resolve({ surface: 'chat', tier: 'budget' })).toMatchObject({ provider: 'openai', model: 'o-b', source: 'bundled' });
  });

  it('refuses an invalid policy or an incomplete fallback at startup', () => {
    expect(() => createPolicyClient({ policy: { version: '1', tiers: { standard: { provider: 'bedrock', model: 'x' } } } as never })).toThrow(/policy is invalid/);
    expect(() => createPolicyClient({ policy: local, fallback: { version: 'f', tiers: { standard: { provider: 'anthropic', model: 'x' } } } })).toThrow(/every tier/);
  });

  it('throws on an invalid request: a caller cannot declare intent', async () => {
    const c = createPolicyClient({ policy: local });
    await expect(c.resolve({ surface: 'chat', tier: 'standard', intent: 'research' } as never)).rejects.toThrow(/unknown field intent/);
  });

  it('outcome reports go to onOutcome, validated', async () => {
    const seen: OutcomeReport[] = [];
    const c = createPolicyClient({ policy: local, onOutcome: (r) => { seen.push(r); } });
    expect(await c.reportOutcome({ planId: 'p', surface: 'coding', observations: [{ type: 'tests', passed: true }] })).toEqual({ ok: true });
    expect((await c.reportOutcome({ planId: 'p', surface: 'chat', observations: [{ type: 'tests', passed: true }] })).ok).toBe(false);
    expect(seen).toHaveLength(1);
  });
});

describe('remote policy', () => {
  it('sends only surface/tier/app/workspaceId, with the policy token, to the policy endpoint', async () => {
    const f = fakeFetch(() => json(decision()));
    const c = createPolicyClient({ policy: remotePolicy({ endpoint: 'https://policy.example/', token: 'pol_abc', fetch: f.fetch }) });
    const d = await c.resolve({ surface: 'chat', tier: 'standard', app: 'cue' });
    expect(d).toEqual(decision() as never);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://policy.example/v1/resolve');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ surface: 'chat', tier: 'standard', app: 'cue' });
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer pol_abc');
  });

  it('serves the last good decision while the service is down, then the fallback after maxStale', async () => {
    let up = true;
    let t = 1_000_000;
    const f = fakeFetch(() => (up ? json(decision()) : new Response('down', { status: 503 })));
    const events: PolicyClientEvent[] = [];
    const c = createPolicyClient({
      policy: remotePolicy({ endpoint: 'https://policy.example', token: 'pol_abc', fetch: f.fetch }),
      maxStaleSeconds: 60, now: () => t, onError: (e) => events.push(e),
    });
    await c.resolve({ surface: 'chat', tier: 'standard' });
    up = false;
    expect(await c.resolve({ surface: 'chat', tier: 'standard' })).toMatchObject({ model: 'remote-model', source: 'cached', planId: 'plan-1' });
    t += 61_000;
    expect(await c.resolve({ surface: 'chat', tier: 'standard' })).toMatchObject({ ...DEFAULT_MODEL_POLICY.tiers.standard, source: 'fallback', planId: null });
    expect(events.map((e) => e.code)).toEqual(['http_503', 'http_503']);
  });

  it('a timeout falls back', async () => {
    const f = fakeFetch(() => new Promise<Response>(() => {}));
    const c = createPolicyClient({ policy: remotePolicy({ endpoint: 'https://policy.example', token: 'pol_abc', fetch: f.fetch, timeoutMs: 10 }) });
    expect(await c.resolve({ surface: 'coding', tier: 'premium' })).toMatchObject({ ...DEFAULT_MODEL_POLICY.tiers.premium, source: 'fallback', surface: 'coding' });
  });

  it('the fallback can be the app\'s own policy', async () => {
    const f = fakeFetch(() => { throw new Error('ECONNREFUSED'); });
    const c = createPolicyClient({
      policy: remotePolicy({ endpoint: 'https://policy.example', token: 'pol_abc', fetch: f.fetch }),
      fallback: { ...DEFAULT_MODEL_POLICY, version: 'app-fallback', surfaces: { chat: { standard: { provider: 'openrouter', model: 'app-chat' } } } },
    });
    expect(await c.resolve({ surface: 'chat', tier: 'standard' })).toMatchObject({ model: 'app-chat', source: 'fallback', policyVersion: 'app-fallback' });
  });

  it('refuses a remote answer that carries a credential and falls back instead', async () => {
    const f = fakeFetch(() => json(decision({ providerKey: 'sk-or-v1-leak' })));
    const events: PolicyClientEvent[] = [];
    const c = createPolicyClient({ policy: remotePolicy({ endpoint: 'https://policy.example', token: 'pol_abc', fetch: f.fetch }), onError: (e) => events.push(e) });
    const d = await c.resolve({ surface: 'chat', tier: 'standard' });
    expect(d.source).toBe('fallback');
    expect(JSON.stringify(d)).not.toContain('sk-or');
    expect(events[0]).toMatchObject({ code: 'bad_response' });
  });

  it('refuses an answer for the other surface', async () => {
    const f = fakeFetch(() => json(decision({ surface: 'coding' })));
    const c = createPolicyClient({ policy: remotePolicy({ endpoint: 'https://policy.example', token: 'pol_abc', fetch: f.fetch }) });
    expect((await c.resolve({ surface: 'chat', tier: 'standard' })).source).toBe('fallback');
  });

  it('posts typed outcomes to the same endpoint with the same token', async () => {
    const f = fakeFetch(() => new Response(null, { status: 202 }));
    const c = createPolicyClient({ policy: remotePolicy({ endpoint: 'https://policy.example', token: 'pol_abc', fetch: f.fetch }) });
    const report: OutcomeReport = { planId: 'plan-1', surface: 'chat', observations: [{ type: 'explicit_feedback', value: 'up' }] };
    expect(await c.reportOutcome(report)).toEqual({ ok: true });
    expect(f.calls[0].url).toBe('https://policy.example/v1/outcomes');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual(report);
  });
});

describe('policy credentials are not provider credentials', () => {
  it.each(['sk-ant-api03-xyz', 'sk-or-v1-xyz', 'sk-proj-xyz'])('refuses a provider key (%s) as the policy token', (token) => {
    expect(() => remotePolicy({ endpoint: 'https://policy.example', token })).toThrow(/provider key/);
  });

  it('refuses plain http off localhost; the token travels with every call', () => {
    expect(() => remotePolicy({ endpoint: 'http://policy.example', token: 'pol_abc' })).toThrow(/https/);
    expect(() => remotePolicy({ endpoint: 'http://localhost:8787', token: 'pol_abc' })).not.toThrow();
  });

  it('the client takes no provider key option and a decision has no credential field', async () => {
    const c = createPolicyClient({ policy: local });
    const d = await c.resolve({ surface: 'coding', tier: 'standard' });
    expect(Object.keys(d).filter((k) => /key|secret|token|credential|auth/i.test(k))).toEqual([]);
  });
});
