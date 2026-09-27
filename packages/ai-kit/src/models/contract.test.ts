/**
 * Contract test: the kit's wire shapes against buildd's own validators
 * (`apps/web/src/lib/ai/plan.ts`, `usage.ts`). Those modules are pure (their
 * imports are `@buildd/core/model-tier-defaults`, `@/lib/uuid` and
 * `@/lib/chat/openrouter-id`: no DB, no Next), so they load here without the
 * app. The import is dynamic with a computed path so the kit's own `tsc`
 * never type-checks app code. In a checkout without `apps/web` (the published
 * package) the suite is skipped.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createModelsClient, KIT_PROVIDERS, KIT_TIERS, MAX_USAGE_RECORDS, PLAN_SOURCES, PLAN_SURFACES,
  toWireReceipt, USAGE_RECORD_KEYS, type ResolvedPlan, type UsageReceipt,
} from './index';

type Validation = { ok: boolean; error?: string; value?: unknown };
interface ServerUsage {
  validateUsageBody(body: unknown): Validation;
  USAGE_PLAN_SOURCES: readonly string[];
  MAX_USAGE_RECORDS: number;
}
interface ServerPlan {
  validatePlanRequest(body: unknown): Validation;
  PLAN_PROVIDERS: readonly string[];
  PLAN_SURFACES: readonly string[];
}

const serverDir = join(import.meta.dir, '../../../../apps/web/src/lib/ai');
const available = existsSync(join(serverDir, 'usage.ts'));
const load = async <T>(file: string): Promise<T> => (await import(join(serverDir, file))) as T;

const plan: ResolvedPlan = {
  planId: '11111111-2222-4333-8444-555555555555', planSource: 'cached', requestedTier: 'standard', tier: 'standard',
  surface: 'chat', kind: 'chat_turn', provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', effort: null,
  limits: { maxTurns: null }, price: null, budget: null, expiresAt: '2026-09-27T12:00:00.000Z',
};
const full: UsageReceipt = {
  plan, tokens: { input: 1200, output: 300, cacheRead: 10, cacheWrite: 5 }, costUsd: 0.0031, latencyMs: 850, outcome: 'ok', feedback: 'down',
};

describe.skipIf(!available)('contract with buildd /api/ai/usage', () => {
  it('shares the enums and batch limit', async () => {
    const s = await load<ServerUsage>('usage.ts');
    const p = await load<ServerPlan>('plan.ts');
    expect<string[]>([...PLAN_SOURCES]).toEqual([...s.USAGE_PLAN_SOURCES]);
    expect(MAX_USAGE_RECORDS).toBe(s.MAX_USAGE_RECORDS);
    expect<string[]>([...KIT_PROVIDERS]).toEqual([...p.PLAN_PROVIDERS]);
    expect<string[]>([...PLAN_SURFACES]).toEqual([...p.PLAN_SURFACES]);
  });

  it('the server accepts every record the kit builds (fresh, cached, fallback, minimal)', async () => {
    const s = await load<ServerUsage>('usage.ts');
    const variants: UsageReceipt[] = [
      full,
      { ...full, plan: { ...plan, planSource: 'registry' } },
      { ...full, plan: { ...plan, planId: null, planSource: 'fallback' } },
      { plan, tokens: { input: 0, output: 0 }, latencyMs: 0, outcome: 'aborted' },
    ];
    const records = variants.map((r) => {
      const w = toWireReceipt(r);
      if (!w.ok) throw new Error(w.error);
      return w.record;
    });
    for (const rec of records) expect(s.validateUsageBody(rec)).toMatchObject({ ok: true });
    expect(s.validateUsageBody({ records })).toMatchObject({ ok: true });
  });

  it('the kit refuses what the server refuses', async () => {
    const s = await load<ServerUsage>('usage.ts');
    const bad: UsageReceipt[] = [
      { ...full, plan: { ...plan, planId: 'nope' } },
      { ...full, plan: { ...plan, model: 'two words' } },
      { ...full, costUsd: -1 },
      { ...full, latencyMs: 25 * 60 * 60 * 1000 },
    ];
    for (const r of bad) {
      expect(toWireReceipt(r).ok).toBe(false);
      // Hand-build what a naive client would send, to prove the server refuses it too.
      const naive = { planId: r.plan.planId, model: r.plan.model, provider: r.plan.provider, tier: r.plan.tier, planSource: r.plan.planSource, tokens: { input: 1, output: 1 }, costUsd: r.costUsd, latencyMs: r.latencyMs, outcome: r.outcome };
      expect(s.validateUsageBody(naive)).toMatchObject({ ok: false });
    }
  });

  it('every key the kit may send is one the server allows (adding one to the kit fails here)', async () => {
    const s = await load<ServerUsage>('usage.ts');
    const w = toWireReceipt(full);
    if (!w.ok) throw new Error(w.error);
    expect(Object.keys(w.record).sort()).toEqual([...USAGE_RECORD_KEYS].sort());
    expect(s.validateUsageBody(w.record)).toMatchObject({ ok: true });
    // And the server really is strict about the rest.
    expect(s.validateUsageBody({ ...w.record, subject: 'u1' })).toMatchObject({ ok: false });
  });
});

describe.skipIf(!available)('contract with buildd /api/ai/plan', () => {
  it('the server accepts every request body the kit sends', async () => {
    const p = await load<ServerPlan>('plan.ts');
    const bodies: unknown[] = [];
    const client = createModelsClient({
      apiKey: 'bld_x', providers: ['openrouter', 'anthropic'],
      defaults: Object.fromEntries(KIT_TIERS.map((t) => [t, { provider: 'openrouter', model: 'x/y' }])) as never,
      fetch: async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); throw new Error('offline'); },
    });
    await client.plan({ tier: 'standard', kind: 'chat_turn' });
    await client.plan({ tier: 'premium-plus', kind: 'txn.explain', surface: 'inference', workspaceId: '11111111-2222-4333-8444-555555555555' });
    await client.plan({ tier: 'budget', kind: 'classify', budget: { maxUsdPerCall: 0.01, expectedTokens: { input: 100, output: 10 } } });
    await client.plan({ tier: 'premium', kind: 'k', budget: {} });
    expect(bodies).toHaveLength(4);
    for (const b of bodies) expect(p.validatePlanRequest(b)).toMatchObject({ ok: true });
  });
});
