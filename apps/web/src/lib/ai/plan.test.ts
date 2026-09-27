import { describe, it, expect } from 'bun:test';
import {
  validatePlanRequest, routeEntry, tiersFrom, decidePlan, buildPlanResponse, estimateCallUsd,
  DEFAULT_EXPECTED_TOKENS, PLAN_TTL_SECONDS, PLAN_MAX_STALE_SECONDS,
  type PlanOption, type PoolArmPick, type RoutedModel,
} from './plan';

const price = (input: number, output: number) => ({ input, output, cacheRead: input / 10, cacheWrite: input * 1.25 });
const routed = (model: string, provider: RoutedModel['provider'] = 'openrouter'): RoutedModel =>
  ({ provider, model, source: 'registry', poolId: null, armId: null });

describe('validatePlanRequest', () => {
  const base = { tier: 'standard', kind: 'chat_turn', providers: ['openrouter'] };

  it('accepts the minimal body and fills defaults', () => {
    const v = validatePlanRequest(base);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value).toEqual({
      tier: 'standard', surface: 'chat', kind: 'chat_turn', providers: ['openrouter'], workspaceId: null,
      budget: { maxUsdPerCall: null, expectedTokens: { ...DEFAULT_EXPECTED_TOKENS } },
    });
  });

  it('accepts every documented field', () => {
    const v = validatePlanRequest({
      ...base, surface: 'inference', providers: ['anthropic', 'openrouter', 'anthropic'],
      workspaceId: '11111111-1111-4111-8111-111111111111',
      budget: { maxUsdPerCall: 0.05, expectedTokens: { input: 1000, output: 200 } },
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.providers).toEqual(['anthropic', 'openrouter']);
    expect(v.value.budget).toEqual({ maxUsdPerCall: 0.05, expectedTokens: { input: 1000, output: 200 } });
  });

  it('rejects unknown fields, so content cannot ride along', () => {
    const v = validatePlanRequest({ ...base, prompt: 'hello' });
    expect(v).toEqual({ ok: false, error: 'unknown field(s): prompt' });
    expect(validatePlanRequest({ ...base, budget: { maxUsdPerCall: 1, userId: 'u' } }).ok).toBe(false);
  });

  it.each([
    [{ ...base, tier: 'gold' }, 'tier'],
    [{ ...base, surface: 'agent' }, 'surface'],
    [{ ...base, kind: '' }, 'kind'],
    [{ ...base, kind: 'has spaces in it' }, 'kind'],
    [{ ...base, providers: [] }, 'providers'],
    [{ ...base, providers: ['openai-codex'] }, 'provider'],
    [{ ...base, workspaceId: 'ws-1' }, 'workspaceId'],
    [{ ...base, budget: { maxUsdPerCall: 0 } }, 'maxUsdPerCall'],
    [{ ...base, budget: { expectedTokens: { input: -1, output: 1 } } }, 'expectedTokens'],
  ])('rejects %j', (body, field) => {
    const v = validatePlanRequest(body);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain(field);
  });

  it('rejects a non-object body', () => {
    expect(validatePlanRequest([]).ok).toBe(false);
    expect(validatePlanRequest(null).ok).toBe(false);
  });
});

describe('routeEntry', () => {
  const entry = { provider: 'anthropic' as const, model: 'claude-sonnet-5', source: 'team' as const };

  it('serves the tier natively when the app holds that provider', () => {
    expect(routeEntry(entry, null, ['anthropic'])).toEqual(
      { provider: 'anthropic', model: 'claude-sonnet-5', source: 'registry', poolId: null, armId: null });
  });

  it('rewrites onto OpenRouter when that is the only key', () => {
    expect(routeEntry({ ...entry, model: 'claude-haiku-4-5-20251001' }, null, ['openrouter'])).toMatchObject(
      { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' });
    expect(routeEntry({ provider: 'openai', model: 'gpt-5.6-terra', source: 'default' }, null, ['openrouter'])).toMatchObject(
      { provider: 'openrouter', model: 'openai/gpt-5.6-terra', source: 'default' });
  });

  it('returns null when the app cannot reach the tier', () => {
    expect(routeEntry(entry, null, ['openai'])).toBeNull();
    expect(routeEntry({ provider: 'openrouter', model: 'qwen/qwen3', source: 'team' }, null, ['anthropic'])).toBeNull();
    expect(routeEntry({ provider: 'openai-codex', model: 'gpt-5.6', source: 'team' }, null, ['openai'])).toBeNull();
  });

  it('maps catalog and default sources through', () => {
    expect(routeEntry({ ...entry, source: 'catalog' }, null, ['anthropic'])?.source).toBe('catalog');
    expect(routeEntry({ ...entry, source: undefined }, null, ['anthropic'])?.source).toBe('default');
    expect(routeEntry({ ...entry, source: 'workspace' }, null, ['anthropic'])?.source).toBe('registry');
  });

  const challenger: PoolArmPick = { poolId: 'p1', armId: 'a2', route: 'openrouter', model: 'qwen/qwen3-coder', role: 'challenger' };

  it('serves a drawn challenger on its exact route', () => {
    expect(routeEntry(entry, challenger, ['openrouter'])).toEqual(
      { provider: 'openrouter', model: 'qwen/qwen3-coder', source: 'pool', poolId: 'p1', armId: 'a2' });
  });

  it('serves the incumbent when the app cannot reach the challenger route, keeping only the pool link', () => {
    expect(routeEntry(entry, challenger, ['anthropic'])).toEqual(
      { provider: 'anthropic', model: 'claude-sonnet-5', source: 'registry', poolId: 'p1', armId: null });
  });

  it('keeps the arm link when the draw landed on the incumbent', () => {
    const inc: PoolArmPick = { poolId: 'p1', armId: 'a1', route: 'anthropic', model: 'claude-sonnet-5', role: 'incumbent' };
    expect(routeEntry(entry, inc, ['anthropic'])).toMatchObject({ source: 'registry', poolId: 'p1', armId: 'a1' });
  });
});

describe('tiersFrom', () => {
  it('lists the tier and every cheaper one', () => {
    expect(tiersFrom('premium-plus')).toEqual(['premium-plus', 'premium', 'standard', 'budget']);
    expect(tiersFrom('standard')).toEqual(['standard', 'budget']);
    expect(tiersFrom('budget')).toEqual(['budget']);
  });
});

describe('decidePlan', () => {
  const opts: PlanOption[] = [
    { tier: 'premium', routed: routed('anthropic/claude-opus-5'), price: price(5, 25) },
    { tier: 'standard', routed: routed('anthropic/claude-sonnet-5'), price: price(2, 10) },
    { tier: 'budget', routed: routed('anthropic/claude-haiku-4.5'), price: price(1, 5) },
  ];
  const tokens = { input: 2000, output: 500 };
  const base = { options: opts, spentTodayUsd: 0, dailyCapUsd: null, maxUsdPerCall: null, expectedTokens: tokens };

  it('estimates a call from list price', () => {
    expect(estimateCallUsd(price(5, 25), tokens)).toBeCloseTo(0.0225, 10);
  });

  it('is ok with no cap and no per-call limit', () => {
    expect(decidePlan(base)).toEqual({ action: 'ok', reason: null, index: 0, estimatedCallUsd: 0.0225, remainingUsd: null });
  });

  it('denies when the requested tier cannot be routed, rather than silently changing tier', () => {
    const d = decidePlan({ ...base, options: [{ ...opts[0], routed: null, price: null }, opts[1], opts[2]] });
    expect(d).toMatchObject({ action: 'deny', reason: 'no_routable_provider', index: null });
  });

  it('denies at or over the daily cap', () => {
    expect(decidePlan({ ...base, dailyCapUsd: 10, spentTodayUsd: 10 })).toMatchObject(
      { action: 'deny', reason: 'daily_cap_reached', remainingUsd: 0 });
  });

  it('downgrades one tier from 80% of the cap', () => {
    expect(decidePlan({ ...base, dailyCapUsd: 10, spentTodayUsd: 8 })).toMatchObject(
      { action: 'downgrade', reason: 'daily_cap_near', index: 1, remainingUsd: 2 });
    expect(decidePlan({ ...base, dailyCapUsd: 10, spentTodayUsd: 7.99 })).toMatchObject({ action: 'ok', index: 0 });
  });

  it('serves the budget tier as is near the cap: there is nowhere cheaper', () => {
    expect(decidePlan({ ...base, options: [opts[2]], dailyCapUsd: 10, spentTodayUsd: 9 })).toMatchObject(
      { action: 'ok', reason: null, index: 0 });
  });

  it('walks down to the first tier under maxUsdPerCall', () => {
    // premium 0.0225, standard 0.009, budget 0.0045
    expect(decidePlan({ ...base, maxUsdPerCall: 0.01 })).toMatchObject(
      { action: 'downgrade', reason: 'per_call_limit', index: 1, estimatedCallUsd: 0.009 });
    expect(decidePlan({ ...base, maxUsdPerCall: 0.005 })).toMatchObject({ action: 'downgrade', index: 2 });
  });

  it('denies when no tier fits the per-call limit', () => {
    expect(decidePlan({ ...base, maxUsdPerCall: 0.001 })).toMatchObject(
      { action: 'deny', reason: 'per_call_limit', estimatedCallUsd: 0.0045 });
  });

  it('treats what is left of the cap as a per-call limit too', () => {
    // 80% crossed -> start at standard (0.009); only 0.005 left -> budget (0.0045).
    expect(decidePlan({ ...base, dailyCapUsd: 1, spentTodayUsd: 0.995 })).toMatchObject(
      { action: 'downgrade', reason: 'daily_cap_near', index: 2 });
    // Under 80% but a single big call would overrun what is left.
    const big = { input: 200_000, output: 50_000 }; // premium 2.25, standard 0.9, budget 0.45
    expect(decidePlan({ ...base, expectedTokens: big, dailyCapUsd: 10, spentTodayUsd: 7.9 })).toMatchObject(
      { action: 'downgrade', reason: 'daily_cap_near', index: 1 });
  });

  it('skips a cheaper tier the app cannot route', () => {
    const d = decidePlan({ ...base, options: [opts[0], { ...opts[1], routed: null, price: null }, opts[2]], maxUsdPerCall: 0.01 });
    expect(d).toMatchObject({ action: 'downgrade', index: 2 });
  });
});

describe('buildPlanResponse', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');
  const request = {
    tier: 'premium' as const, surface: 'chat' as const, kind: 'chat_turn', providers: ['openrouter' as const],
    workspaceId: null, budget: { maxUsdPerCall: 0.01, expectedTokens: { input: 2000, output: 500 } },
  };
  const options: PlanOption[] = [
    { tier: 'premium', routed: routed('anthropic/claude-opus-5'), price: price(5, 25) },
    { tier: 'standard', routed: routed('anthropic/claude-sonnet-5'), price: price(2, 10) },
  ];
  const entries = { premium: { defaultEffort: 'high' as const }, standard: { defaultEffort: 'medium' as const, defaultMaxTurns: 8 } };

  it('describes the served tier on a downgrade, with price, limits and a TTL', () => {
    const r = buildPlanResponse({
      planId: 'plan-1', request, options, entries, now, spentTodayUsd: 0, dailyCapUsd: null,
      decision: { action: 'downgrade', reason: 'per_call_limit', index: 1, estimatedCallUsd: 0.009, remainingUsd: null },
    });
    expect(r).toEqual({
      planId: 'plan-1', requestedTier: 'premium', tier: 'standard', surface: 'chat', kind: 'chat_turn',
      provider: 'openrouter', model: 'anthropic/claude-sonnet-5', source: 'registry',
      effort: 'medium', limits: { maxTurns: 8 },
      price: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
      budget: { action: 'downgrade', reason: 'per_call_limit', remainingUsd: null, dailyCapUsd: null, spentTodayUsd: 0, estimatedCallUsd: 0.009 },
      ttlSeconds: PLAN_TTL_SECONDS,
      expiresAt: '2026-09-27T12:01:00.000Z',
      maxStaleSeconds: PLAN_MAX_STALE_SECONDS,
    });
  });

  it('offers no model on a deny', () => {
    const r = buildPlanResponse({
      planId: 'plan-2', request, options, entries, now, spentTodayUsd: 12, dailyCapUsd: 10,
      decision: { action: 'deny', reason: 'daily_cap_reached', index: null, estimatedCallUsd: null, remainingUsd: 0 },
    });
    expect(r).toMatchObject({ tier: 'premium', provider: null, model: null, price: null, effort: null, limits: { maxTurns: null } });
    expect(r.budget).toEqual({ action: 'deny', reason: 'daily_cap_reached', remainingUsd: 0, dailyCapUsd: 10, spentTodayUsd: 12, estimatedCallUsd: null });
  });
});
