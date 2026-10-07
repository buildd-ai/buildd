import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPolicyClient, findCredentialLike, remotePolicy, type ModelPolicy } from '@builddai/ai-kit/policy';
import { ENV_KEYS, handle, type Deps, type Env } from './handler';
import { parseTokenRing } from './auth';

const TOKEN = 'pol_test_token_0123456789abcdef';
const policy: ModelPolicy = {
  version: '42',
  tiers: { standard: { provider: 'openrouter', model: 'base-standard' } },
  surfaces: { coding: { standard: { provider: 'anthropic', model: 'coding-standard', effort: 'high' } } },
  experiments: [{ key: 'chat-shadow', mode: 'shadow', tier: 'standard', surface: 'chat', arms: [{ name: 'c', route: { provider: 'openrouter', model: 'challenger' } }] }],
};
const env: Env = { POLICY_TOKENS: `app1:${TOKEN}`, MODEL_POLICY: JSON.stringify(policy) };

function deps() {
  const logs: Record<string, unknown>[] = [];
  let n = 0;
  const d: Deps = { planId: () => `pl_${++n}`, log: (e) => { logs.push(e); } };
  return { d, logs };
}
const post = (path: string, body: unknown, token: string | null = TOKEN) =>
  new Request(`https://policy.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /v1/resolve', () => {
  it('maps chat and coding through one resolver and issues a planId', async () => {
    const { d, logs } = deps();
    const chat = await (await handle(post('/v1/resolve', { surface: 'chat', tier: 'standard', app: 'cue' }), env, d)).json();
    expect(chat).toMatchObject({ provider: 'openrouter', model: 'base-standard', source: 'tier', policyVersion: '42', planId: 'pl_1', surface: 'chat' });
    expect(chat.experiment).toMatchObject({ key: 'chat-shadow', mode: 'shadow', arm: 'control', shadow: { model: 'challenger' } });
    const coding = await (await handle(post('/v1/resolve', { surface: 'coding', tier: 'standard' }), env, d)).json();
    expect(coding).toMatchObject({ provider: 'anthropic', model: 'coding-standard', effort: 'high', source: 'surface', planId: 'pl_2' });
    expect(coding.experiment).toBeUndefined();
    expect(logs[0]).toMatchObject({ event: 'policy.resolve', tokenId: 'app1', app: 'cue', model: 'base-standard' });
  });

  it('refuses a declared intent and buildd\'s agent surface', async () => {
    const { d } = deps();
    const a = await handle(post('/v1/resolve', { surface: 'chat', tier: 'standard', intent: 'research' }), env, d);
    expect(a.status).toBe(400);
    const b = await handle(post('/v1/resolve', { surface: 'agent', tier: 'standard' }), env, d);
    expect(((await b.json()) as { message: string }).message).toContain("'coding'");
  });

  it('503s without a valid policy, so the client uses its own fallback', async () => {
    const { d } = deps();
    expect((await handle(post('/v1/resolve', { surface: 'chat', tier: 'standard' }), { ...env, MODEL_POLICY: undefined }, d)).status).toBe(503);
    expect((await handle(post('/v1/resolve', { surface: 'chat', tier: 'standard' }), { ...env, MODEL_POLICY: '{"version":"1","tiers":{"standard":{"provider":"x","model":"y"}}}' }, d)).status).toBe(503);
    expect((await handle(post('/v1/resolve', { surface: 'chat', tier: 'standard' }), { ...env, MODEL_POLICY: 'nope' }, d)).status).toBe(503);
  });

  it('end to end with the kit client: remote answer, then the app fallback when the service refuses', async () => {
    const { d } = deps();
    const viaWorker = (e: Env) => async (url: string, init?: RequestInit) => handle(new Request(url, init), e, d);
    const ok = createPolicyClient({ policy: remotePolicy({ endpoint: 'https://policy.example', token: TOKEN, fetch: viaWorker(env) }) });
    expect(await ok.resolve({ surface: 'coding', tier: 'standard' })).toMatchObject({ model: 'coding-standard', planId: 'pl_1' });
    const down = createPolicyClient({ policy: remotePolicy({ endpoint: 'https://policy.example', token: TOKEN, fetch: viaWorker({ ...env, MODEL_POLICY: undefined }) }) });
    expect(await down.resolve({ surface: 'coding', tier: 'standard' })).toMatchObject({ source: 'fallback', planId: null });
  });
});

describe('POST /v1/outcomes', () => {
  it('accepts typed observations and logs them content-free', async () => {
    const { d, logs } = deps();
    const res = await handle(post('/v1/outcomes', { planId: 'pl_1', surface: 'coding', observations: [{ type: 'tests', passed: true }, { type: 'merged', merged: true }] }), env, d);
    expect(res.status).toBe(202);
    expect(logs[0]).toEqual({ event: 'policy.outcome', tokenId: 'app1', planId: 'pl_1', surface: 'coding', observations: [{ type: 'tests', passed: true }, { type: 'merged', merged: true }] });
  });

  it('refuses a generic quality score', async () => {
    const { d } = deps();
    const res = await handle(post('/v1/outcomes', { planId: 'pl_1', surface: 'chat', observations: [{ type: 'quality', score: 0.9 }] }), env, d);
    expect(res.status).toBe(400);
  });
});

describe('credential boundary', () => {
  it('a policy token is required, and only a policy token works', async () => {
    const { d } = deps();
    expect((await handle(post('/v1/resolve', { surface: 'chat', tier: 'standard' }, null), env, d)).status).toBe(401);
    expect((await handle(post('/v1/resolve', { surface: 'chat', tier: 'standard' }, 'bld_some_buildd_api_key_value'), env, d)).status).toBe(401);
    expect((await handle(post('/v1/resolve', { surface: 'chat', tier: 'standard' }, `${TOKEN}x`), env, d)).status).toBe(401);
  });

  it('fails closed with no token ring, or a malformed one', async () => {
    const { d } = deps();
    expect((await handle(post('/v1/resolve', { surface: 'chat', tier: 'standard' }), { ...env, POLICY_TOKENS: '' }, d)).status).toBe(503);
    expect(parseTokenRing(`a:${TOKEN},broken`)).toEqual([]);
    expect(parseTokenRing('a:short')).toEqual([]);
    expect(parseTokenRing(`a:${TOKEN},b:${TOKEN}y`).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('the Worker is configured with a policy token ring and a policy, nothing else', () => {
    expect([...ENV_KEYS]).toEqual(['POLICY_TOKENS', 'MODEL_POLICY']);
    const wrangler = readFileSync(join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8');
    expect(wrangler).not.toMatch(/OPENROUTER|ANTHROPIC|OPENAI|BUILDD_|DATABASE_URL|API_KEY/);
  });

  it('no response carries anything credential-shaped', async () => {
    const { d } = deps();
    const bodies = await Promise.all([
      handle(post('/v1/resolve', { surface: 'chat', tier: 'standard' }), env, d),
      handle(post('/v1/resolve', { surface: 'coding', tier: 'budget' }), env, d),
      handle(new Request('https://policy.example/health'), env, d),
    ].map(async (p) => (await p).json()));
    for (const b of bodies) expect(findCredentialLike(b)).toBeNull();
  });
});

describe('routing', () => {
  it('health needs no token and reports the policy version', async () => {
    const res = await handle(new Request('https://policy.example/health'), env, deps().d);
    expect(await res.json()).toEqual({ ok: true, policyVersion: '42' });
  });

  it('404 / 405 / 400 / 413', async () => {
    const { d } = deps();
    expect((await handle(new Request('https://policy.example/v1/plan'), env, d)).status).toBe(404);
    expect((await handle(new Request('https://policy.example/v1/resolve'), env, d)).status).toBe(405);
    expect((await handle(post('/v1/resolve', '{not json'), env, d)).status).toBe(400);
    expect((await handle(post('/v1/resolve', JSON.stringify({ surface: 'chat', tier: 'standard', app: 'x'.repeat(20_000) })), env, d)).status).toBe(413);
  });
});
