// POST /api/ai/plan. The route binds handlePlanRequest to DB-backed deps; the
// handler is driven here with injected fakes, so no module is replaced and
// nothing asserts on rendered SQL (CI can run test files in one process).
import { describe, it, expect } from 'bun:test';
import type { Tier, TierEntry } from '@buildd/core/model-tier-defaults';
import { handlePlanRequest, type PlanDeps, type PlanRow, type AiApiAccount } from '@/lib/ai/handlers';
import type { PoolArmPick } from '@/lib/ai/plan';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const ACCOUNT: AiApiAccount = { id: 'acct-app', teamId: 'team-a' };
const WS = '33333333-3333-4333-8333-333333333333';

const REGISTRY: Record<Tier, TierEntry> = {
  'premium-plus': { provider: 'anthropic', model: 'claude-fable-5-1', source: 'default' },
  premium: { provider: 'anthropic', model: 'claude-opus-5', source: 'team', defaultEffort: 'high' },
  standard: { provider: 'anthropic', model: 'claude-sonnet-5', source: 'workspace', defaultEffort: 'medium', defaultMaxTurns: 8 },
  budget: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', source: 'catalog' },
};
const PRICES: Record<string, number[]> = {
  'anthropic/claude-opus-5': [5, 25], 'anthropic/claude-sonnet-5': [2, 10], 'anthropic/claude-haiku-4.5': [1, 5],
  'claude-sonnet-5': [2, 10], 'qwen/qwen3-coder': [0.5, 2],
};

function makeDeps(over: Partial<PlanDeps> = {}) {
  const saved: PlanRow[] = [];
  const calls = { resolveEntry: [] as Array<[Tier, string, string | null]>, drawPoolArm: [] as unknown[] };
  const deps: PlanDeps = {
    authenticate: async (b) => (b === 'bld_app' ? ACCOUNT : null),
    canUseWorkspace: async (_a, ws) => ws === WS,
    defaultWorkspaceId: async () => null,
    resolveEntry: async (tier, teamId, ws) => { calls.resolveEntry.push([tier, teamId, ws]); return REGISTRY[tier]; },
    drawPoolArm: async (args) => { calls.drawPoolArm.push(args); return null; },
    chatCatalog: async () => [],
    price: async (_p, model) => {
      const [input, output] = PRICES[model] ?? [3, 15];
      return { input, output, cacheRead: input / 10, cacheWrite: input * 1.25 };
    },
    loadBudget: async () => ({ dailyCapUsd: null, spentTodayUsd: 0 }),
    savePlan: async (row) => { saved.push(row); },
    now: () => NOW,
    newId: () => 'plan-1',
    ...over,
  };
  return { deps, saved, calls };
}

function req(body: unknown, key: string | null = 'bld_app') {
  return new Request('http://localhost/api/ai/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const BODY = { tier: 'standard', surface: 'chat', kind: 'chat_turn', providers: ['openrouter'] };

describe('POST /api/ai/plan — auth and validation', () => {
  it('401s without a key, and with a key that does not authenticate', async () => {
    const { deps } = makeDeps();
    expect((await handlePlanRequest(req(BODY, null), deps)).status).toBe(401);
    expect((await handlePlanRequest(req(BODY, 'bld_wrong'), deps)).status).toBe(401);
  });

  it('401s for an account with no team', async () => {
    const { deps } = makeDeps({ authenticate: async () => ({ id: 'x', teamId: '' }) });
    expect((await handlePlanRequest(req(BODY), deps)).status).toBe(401);
  });

  it('400s on bad JSON and on an invalid body, before touching the registry', async () => {
    const { deps, calls } = makeDeps();
    expect((await handlePlanRequest(req('{nope'), deps)).status).toBe(400);
    const res = await handlePlanRequest(req({ ...BODY, prompt: 'hi' }), deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('prompt');
    expect(calls.resolveEntry).toHaveLength(0);
  });

  it('404s for a workspace the key cannot reach', async () => {
    const { deps, calls } = makeDeps();
    const res = await handlePlanRequest(req({ ...BODY, workspaceId: '44444444-4444-4444-8444-444444444444' }), deps);
    expect(res.status).toBe(404);
    expect(calls.resolveEntry).toHaveLength(0);
  });
});

describe('POST /api/ai/plan — the plan', () => {
  it('resolves the key\'s own team, routes onto OpenRouter, and returns the documented shape', async () => {
    const { deps, saved, calls } = makeDeps();
    const res = await handlePlanRequest(req(BODY), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      planId: 'plan-1', requestedTier: 'standard', tier: 'standard', surface: 'chat', kind: 'chat_turn',
      provider: 'openrouter', model: 'anthropic/claude-sonnet-5', source: 'registry',
      effort: 'medium', limits: { maxTurns: 8 },
      price: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
      budget: { action: 'ok', reason: null, remainingUsd: null, dailyCapUsd: null, spentTodayUsd: 0, estimatedCallUsd: 0.009 },
      ttlSeconds: 60, expiresAt: '2026-09-27T12:01:00.000Z', maxStaleSeconds: 86400,
    });
    // The team comes from the key; nothing in the body can name another team.
    expect(calls.resolveEntry.map(([, team]) => team)).toEqual(['team-a', 'team-a']);
    expect(saved).toEqual([{
      id: 'plan-1', teamId: 'team-a', accountId: 'acct-app', workspaceId: null,
      requestedTier: 'standard', tier: 'standard', surface: 'chat', kind: 'chat_turn',
      provider: 'openrouter', model: 'anthropic/claude-sonnet-5', source: 'registry',
      poolId: null, armId: null, action: 'ok', reason: null,
      createdAt: NOW, expiresAt: new Date('2026-09-27T12:01:00.000Z'),
    }]);
  });

  it('serves the native provider when the app holds it', async () => {
    const { deps } = makeDeps();
    const body = await (await handlePlanRequest(req({ ...BODY, providers: ['anthropic', 'openrouter'] }), deps)).json();
    expect(body).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });

  it('uses a stated workspace, else the key\'s only linked workspace', async () => {
    const a = makeDeps();
    await handlePlanRequest(req({ ...BODY, workspaceId: WS }), a.deps);
    expect(a.calls.resolveEntry[0][2]).toBe(WS);
    expect(a.saved[0].workspaceId).toBe(WS);

    const b = makeDeps({ defaultWorkspaceId: async () => WS });
    await handlePlanRequest(req(BODY), b.deps);
    expect(b.calls.resolveEntry[0][2]).toBe(WS);
  });

  it('downgrades near the daily cap and records it', async () => {
    const { deps, saved } = makeDeps({ loadBudget: async () => ({ dailyCapUsd: 5, spentTodayUsd: 4.5 }) });
    const body = await (await handlePlanRequest(req(BODY), deps)).json();
    expect(body).toMatchObject({
      requestedTier: 'standard', tier: 'budget', model: 'anthropic/claude-haiku-4.5', source: 'catalog',
      budget: { action: 'downgrade', reason: 'daily_cap_near', remainingUsd: 0.5, dailyCapUsd: 5, spentTodayUsd: 4.5 },
    });
    expect(saved[0]).toMatchObject({ requestedTier: 'standard', tier: 'budget', action: 'downgrade', reason: 'daily_cap_near' });
  });

  it('downgrades to fit maxUsdPerCall', async () => {
    const { deps } = makeDeps();
    const body = await (await handlePlanRequest(req({ ...BODY, tier: 'premium', budget: { maxUsdPerCall: 0.01 } }), deps)).json();
    expect(body).toMatchObject({ tier: 'standard', budget: { action: 'downgrade', reason: 'per_call_limit' } });
  });

  it('denies over the daily cap with no model, still as a 200 decision', async () => {
    const { deps, saved } = makeDeps({ loadBudget: async () => ({ dailyCapUsd: 5, spentTodayUsd: 5.2 }) });
    const res = await handlePlanRequest(req(BODY), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ provider: null, model: null, price: null, budget: { action: 'deny', reason: 'daily_cap_reached', remainingUsd: 0 } });
    expect(saved[0]).toMatchObject({ action: 'deny', provider: null, model: null });
  });

  it('denies when the app holds no provider that can serve the tier', async () => {
    const { deps } = makeDeps();
    const body = await (await handlePlanRequest(req({ ...BODY, providers: ['openai'] }), deps)).json();
    expect(body.budget).toMatchObject({ action: 'deny', reason: 'no_routable_provider' });
  });

  it('serves a pool challenger the app can route, and links the arm', async () => {
    const arm: PoolArmPick = { poolId: 'pool-1', armId: 'arm-2', route: 'openrouter', model: 'qwen/qwen3-coder', role: 'challenger' };
    const { deps, saved, calls } = makeDeps({
      drawPoolArm: async (a) => { calls.drawPoolArm.push(a); return a.tier === 'standard' ? arm : null; },
    });
    const body = await (await handlePlanRequest(req(BODY), deps)).json();
    expect(body).toMatchObject({ provider: 'openrouter', model: 'qwen/qwen3-coder', source: 'pool' });
    expect(saved[0]).toMatchObject({ poolId: 'pool-1', armId: 'arm-2', source: 'pool' });
    // The plan id is the draw unit, and a workspace-row tier reports the override.
    expect(calls.drawPoolArm[0]).toMatchObject({ teamId: 'team-a', tier: 'standard', planId: 'plan-1', workspaceOverride: true, now: NOW });
  });

  it('a chat plan never serves a challenger that cannot call tools: the incumbent, no pool link', async () => {
    const arm: PoolArmPick = { poolId: 'pool-1', armId: 'arm-2', route: 'openrouter', model: 'aion-labs/aion-3.5-mini', role: 'challenger' };
    const { deps, saved } = makeDeps({ drawPoolArm: async (a) => (a.tier === 'standard' ? arm : null) });
    const body = await (await handlePlanRequest(req(BODY), deps)).json();
    expect(body).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5', source: 'registry' });
    expect(saved[0]).toMatchObject({ armId: null, model: 'anthropic/claude-sonnet-5' });
  });

  it('a chat plan replaces a registry pick missing from the tool-capable catalog with the tier default', async () => {
    const { deps } = makeDeps({
      resolveEntry: async (tier) => (tier === 'standard' ? { provider: 'openrouter', model: 'vendor/no-tools', source: 'team' } : REGISTRY[tier]),
      chatCatalog: async () => [{ openRouterId: 'anthropic/claude-sonnet-5', permaslug: 'anthropic/claude-sonnet-5' }] as never,
    });
    const body = await (await handlePlanRequest(req(BODY), deps)).json();
    expect(body).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5', source: 'default' });
  });

  it('an inference plan skips the chat check', async () => {
    let asked = 0;
    const arm: PoolArmPick = { poolId: 'pool-1', armId: 'arm-2', route: 'openrouter', model: 'aion-labs/aion-3.5-mini', role: 'challenger' };
    const { deps } = makeDeps({ drawPoolArm: async (a) => (a.tier === 'standard' ? arm : null), chatCatalog: async () => { asked++; return []; } });
    const body = await (await handlePlanRequest(req({ ...BODY, surface: 'inference' }), deps)).json();
    expect(body).toMatchObject({ model: 'aion-labs/aion-3.5-mini', source: 'pool' });
    expect(asked).toBe(0);
  });

  it('500s when the plan cannot be stored, so the kit falls back', async () => {
    const { deps } = makeDeps({ savePlan: async () => { throw new Error('db down'); } });
    const res = await handlePlanRequest(req(BODY), deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
