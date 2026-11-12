import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: { execute: async () => ({ rows: [] }) } }));

const { groupRows, loadPriceTable, estimateCostUsd, windowStartDay, buildBudgets, monthCost } = await import('./embedding-usage');

const T1 = 'team-a';
const T2 = 'team-b';
const row = (o: Record<string, unknown>) => ({ day: '2031-01-02', teamId: T1, kind: 'embed' as const, model: 'm-embed', corpus: 'code', caller: 'ingest', tokens: 100, calls: 2, ...o }) as any;

describe('groupRows', () => {
  it('groups by day, team, model, corpus and caller and sums tokens and calls', () => {
    const out = groupRows([row({}), row({ tokens: 50, calls: 1 }), row({ teamId: T2 }), row({ day: '2031-01-03' }), row({ caller: 'recall' }), row({ corpus: 'memory' })], { 'm-embed': 2 });
    expect(out).toHaveLength(5);
    const first = out.find(r => r.day === '2031-01-02' && r.teamId === T1 && r.caller === 'ingest' && r.corpus === 'code')!;
    expect(first.tokens).toBe(150);
    expect(first.calls).toBe(3);
  });

  it('prices by model and gives null, never 0, for an unpriced model', () => {
    const out = groupRows([row({ tokens: 1_000_000 }), row({ model: 'm-unknown', tokens: 5 })], { 'm-embed': 0.5 });
    expect(out.find(r => r.model === 'm-embed')!.estimatedCostUsd).toBe(0.5);
    expect(out.find(r => r.model === 'm-unknown')!.estimatedCostUsd).toBeNull();
  });
});

describe('price table', () => {
  it('reads positive numbers from config and ignores junk', () => {
    expect(loadPriceTable({ VOYAGE_PRICE_TABLE: '{"a":1.5,"b":0,"c":"x"}' })).toEqual({ a: 1.5 });
    expect(loadPriceTable({ VOYAGE_PRICE_TABLE: 'not json' })).toEqual({});
    expect(loadPriceTable({})).toEqual({});
    expect(estimateCostUsd(10, 'zz', {})).toBeNull();
  });
});

describe('window bounds', () => {
  it('starts at the UTC day the window opens on', () => {
    expect(windowStartDay(new Date('2031-01-02T23:59:59Z'))).toBe('2031-01-02');
    expect(windowStartDay(new Date('2031-01-02T00:00:00Z'))).toBe('2031-01-02');
  });
});

describe('month budgets', () => {
  const byModel = [{ kind: 'embed' as const, model: 'm-embed', tokens: 1_000_000 }, { kind: 'rerank' as const, model: 'm-rr', tokens: 10 }];
  it('has no cap when the guard is not enforced', () => {
    const b = buildBudgets([{ teamId: T1, plan: 'pro', kind: 'embed', tokens: 7 }], byModel, { 'm-embed': 1 }, { VOYAGE_BUDGET_ENFORCED: 'off' });
    expect(b.find(x => x.kind === 'embed')).toEqual({ kind: 'embed', usedTokens: 7, capTokens: null, estimatedCostUsd: 1 });
  });
  it('sums the plan caps the guard applies when enforced, and null cost for an unpriced model', () => {
    const env = { VOYAGE_BUDGET_ENFORCED: 'on', VOYAGE_PAID_EMBED_TOKENS: '1000' };
    const b = buildBudgets([{ teamId: T1, plan: 'team', kind: 'embed', tokens: 7 }, { teamId: T2, plan: 'team', kind: 'embed', tokens: 3 }], byModel, { 'm-embed': 1 }, env);
    const embed = b.find(x => x.kind === 'embed')!;
    expect(embed.usedTokens).toBe(10);
    expect(embed.capTokens).toBe(2000);
    expect(b.find(x => x.kind === 'rerank')!.estimatedCostUsd).toBeNull();
  });
  it('monthCost is null when nothing was spent', () => {
    expect(monthCost([], 'embed', {})).toBeNull();
  });
});

describe('OpenAI-compatible endpoint rows', () => {
  it('tags the provider from key_source, prices a metered row and costs an unmetered row 0', () => {
    const out = groupRows([
      row({ keySource: 'platform', tokens: 1_000_000 }),
      row({ model: 'qwen3', keySource: 'endpoint', tokens: 2_000_000 }),
      row({ model: 'qwen3-local', keySource: 'unmetered', tokens: 9 }),
    ], { 'm-embed': 1, qwen3: 0.01 });
    expect(out.find(r => r.model === 'm-embed')).toMatchObject({ provider: 'voyage', unmetered: false, estimatedCostUsd: 1 });
    expect(out.find(r => r.model === 'qwen3')).toMatchObject({ provider: 'openai_compat', unmetered: false, estimatedCostUsd: 0.02 });
    expect(out.find(r => r.model === 'qwen3-local')).toMatchObject({ provider: 'openai_compat', unmetered: true, estimatedCostUsd: 0 });
  });

  it('prices the configured endpoint model from EMBEDDING_PRICE_PER_1M_TOKENS', () => {
    const env = { EMBEDDING_PROVIDER: 'openai_compat', EMBEDDING_BASE_URL: 'https://e', EMBEDDING_MODEL: 'qwen3', EMBEDDING_PRICE_PER_1M_TOKENS: '0.02' };
    expect(loadPriceTable(env)).toEqual({ qwen3: 0.02 });
    // The explicit table wins.
    expect(loadPriceTable({ ...env, VOYAGE_PRICE_TABLE: '{"qwen3":0.5}' })).toEqual({ qwen3: 0.5 });
    expect(loadPriceTable({ ...env, EMBEDDING_PRICE_PER_1M_TOKENS: 'unmetered' })).toEqual({});
  });

  it('an unmetered model does not make the month cost unknown', () => {
    expect(monthCost([{ kind: 'embed', model: 'local', tokens: 5, keySource: 'unmetered' }, { kind: 'embed', model: 'm', tokens: 1_000_000 }], 'embed', { m: 2 })).toBe(2);
  });
});
