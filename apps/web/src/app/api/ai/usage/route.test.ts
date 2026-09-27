// POST /api/ai/usage. The handler is driven with injected fakes (no
// mock.module), so this file behaves the same in isolated and flat runs.
import { describe, it, expect } from 'bun:test';
import { handleUsageRequest, type UsageDeps, type UsageRow, type PlanRef, type AiApiAccount } from '@/lib/ai/handlers';

const ACCOUNT: AiApiAccount = { id: 'acct-app', teamId: 'team-a' };
const SIBLING: AiApiAccount = { id: 'acct-other-app', teamId: 'team-a' };
const MINE = '55555555-5555-4555-8555-555555555555';
const FOREIGN = '66666666-6666-4666-8666-666666666666';
const DENIED = '77777777-7777-4777-8777-777777777777';

const PLANS: PlanRef[] = [
  { id: MINE, teamId: 'team-a', tier: 'standard', surface: 'chat', kind: 'chat_turn', provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
  { id: FOREIGN, teamId: 'team-b', tier: 'premium', surface: 'chat', kind: 'x', provider: 'anthropic', model: 'claude-opus-5' },
  { id: DENIED, teamId: 'team-a', tier: 'standard', surface: 'inference', kind: 'y', provider: null, model: null },
];

function makeDeps(over: Partial<UsageDeps> = {}) {
  const saved: UsageRow[][] = [];
  const loads: Array<[string, string[]]> = [];
  const deps: UsageDeps = {
    authenticate: async (b) => (b === 'bld_app' ? ACCOUNT : b === 'bld_sibling' ? SIBLING : null),
    // Team-scoped, like the real query; the handler filters again regardless.
    loadPlans: async (teamId, ids) => { loads.push([teamId, ids]); return PLANS.filter((p) => ids.includes(p.id)); },
    price: async () => ({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }),
    saveUsage: async (rows) => { saved.push(rows); },
    ...over,
  };
  return { deps, saved, loads };
}

function req(body: unknown, key: string | null = 'bld_app') {
  return new Request('http://localhost/api/ai/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const REC = { planId: MINE, tokens: { input: 1000, output: 200 }, latencyMs: 900, outcome: 'ok' };

describe('POST /api/ai/usage — auth and the metadata-only schema', () => {
  it('401s without a valid key', async () => {
    const { deps } = makeDeps();
    expect((await handleUsageRequest(req(REC, null), deps)).status).toBe(401);
    expect((await handleUsageRequest(req(REC, 'bld_wrong'), deps)).status).toBe(401);
  });

  it.each([
    ['prompt', { ...REC, prompt: 'what is my balance' }],
    ['response', { ...REC, response: 'you have...' }],
    ['messages', { ...REC, messages: [{ role: 'user', content: 'hi' }] }],
    ['userId', { ...REC, userId: 'u-1' }],
    ['subject', { ...REC, subject: 'tenant-1' }],
    ['batched content', { records: [REC, { ...REC, content: 'x' }] }],
    ['identity beside records', { records: [REC], email: 'a@b.c' }],
  ])('400s on a body with %s and stores nothing', async (_label, body) => {
    const { deps, saved, loads } = makeDeps();
    const res = await handleUsageRequest(req(body), deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('unknown field');
    expect(saved).toHaveLength(0);
    expect(loads).toHaveLength(0);
  });

  it('400s on bad JSON', async () => {
    const { deps } = makeDeps();
    expect((await handleUsageRequest(req('{'), deps)).status).toBe(400);
  });
});

describe('POST /api/ai/usage — storing receipts', () => {
  it('stores a receipt against its plan, estimating cost when none is reported', async () => {
    const { deps, saved, loads } = makeDeps();
    const res = await handleUsageRequest(req(REC), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1, rejected: [] });
    expect(loads).toEqual([['team-a', [MINE]]]);
    expect(saved).toEqual([[{
      teamId: 'team-a', accountId: 'acct-app', planId: MINE, tier: 'standard', surface: 'chat', kind: 'chat_turn',
      provider: 'openrouter', model: 'anthropic/claude-sonnet-5', planSource: null,
      inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.004, costSource: 'estimated', latencyMs: 900, outcome: 'ok', feedback: null,
    }]]);
  });

  it('keeps the app\'s reported cost and its own model when it ran a cached plan', async () => {
    const { deps, saved } = makeDeps();
    await handleUsageRequest(req({ ...REC, costUsd: 0.0031, model: 'anthropic/claude-sonnet-4.6', planSource: 'cached', feedback: 'up' }), deps);
    expect(saved[0][0]).toMatchObject({ model: 'anthropic/claude-sonnet-4.6', costUsd: 0.0031, costSource: 'reported', planSource: 'cached', feedback: 'up' });
  });

  it('accepts a receipt for another key\'s plan in the same team (team scope, not account equality)', async () => {
    const { deps, saved } = makeDeps();
    const res = await handleUsageRequest(req(REC, 'bld_sibling'), deps);
    expect(await res.json()).toEqual({ accepted: 1, rejected: [] });
    expect(saved[0][0]).toMatchObject({ accountId: 'acct-other-app', teamId: 'team-a', planId: MINE });
  });

  it('treats another team\'s plan exactly like a missing one', async () => {
    // Even if a loader regressed and returned it, the handler must not attach it.
    const { deps, saved } = makeDeps({ loadPlans: async (_t, ids) => PLANS.filter((p) => ids.includes(p.id)) });
    const missing = '88888888-8888-4888-8888-888888888888';
    const res = await handleUsageRequest(req({ records: [{ ...REC, planId: FOREIGN }, { ...REC, planId: missing }, REC] }), deps);
    expect(await res.json()).toEqual({
      accepted: 1,
      rejected: [{ index: 0, reason: 'unknown_plan' }, { index: 1, reason: 'unknown_plan' }],
    });
    expect(saved[0].map((r) => r.planId)).toEqual([MINE]);
  });

  it('stores a fallback receipt with no plan when it names what ran', async () => {
    const { deps, saved, loads } = makeDeps();
    const res = await handleUsageRequest(req({
      planId: null, model: 'claude-haiku-4-5', provider: 'anthropic', tier: 'budget', planSource: 'fallback',
      tokens: { input: 10, output: 5 }, latencyMs: 100, outcome: 'error',
    }), deps);
    expect(await res.json()).toEqual({ accepted: 1, rejected: [] });
    expect(loads).toHaveLength(0);
    expect(saved[0][0]).toMatchObject({ planId: null, tier: 'budget', surface: null, kind: null, provider: 'anthropic', outcome: 'error' });
  });

  it('rejects a receipt for a denied plan that names no model', async () => {
    const { deps, saved } = makeDeps();
    const res = await handleUsageRequest(req({ ...REC, planId: DENIED }), deps);
    expect(await res.json()).toEqual({ accepted: 0, rejected: [{ index: 0, reason: 'plan_has_no_model' }] });
    expect(saved).toHaveLength(0);
  });

  it('500s when storage fails', async () => {
    const { deps } = makeDeps({ saveUsage: async () => { throw new Error('db down'); } });
    expect((await handleUsageRequest(req(REC), deps)).status).toBe(500);
  });
});
