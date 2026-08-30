import { describe, it, expect } from 'bun:test';
import { evaluateInitiativeKPIs } from '../mission-helpers';
import type { MetricResolver } from '../initiative-metric-registry';
import type { InitiativeKPI } from '@buildd/shared';

const NOW = '2026-08-30T12:00:00.000Z';
const INIT_ID = 'initiative-test-id';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeResolver(map: Record<string, { value: number } | { unavailable: string }>): MetricResolver {
  return async (key: string, _initiativeId: string) => {
    if (key in map) return map[key];
    return { unavailable: `unknown metric: ${key}` };
  };
}

function makeKpi(overrides: Partial<InitiativeKPI> & { metric: string }): InitiativeKPI {
  return {
    name: overrides.name ?? `KPI for ${overrides.metric}`,
    metric: overrides.metric,
    operator: overrides.operator ?? 'gte',
    threshold: overrides.threshold ?? 80,
    blocking: overrides.blocking,
    unit: overrides.unit,
  };
}

// ─── unknown metric key ───────────────────────────────────────────────────────

describe('evaluateInitiativeKPIs — unknown metric', () => {
  it('returns UNVERIFIED with evidence "unknown metric: <key>" for an unknown key', async () => {
    const kpis = [makeKpi({ metric: 'does_not_exist' })];
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, {
      evaluatedBy: 'auto',
      now: NOW,
      resolver: makeResolver({}),
    });
    expect(state.kpis[0].verdict).toBe('UNVERIFIED');
    expect(state.kpis[0].evidence).toBe('unknown metric: does_not_exist');
    expect(state.kpis[0].observedValue).toBeUndefined();
  });

  it('unknown metric with blocking:true sets overall to UNVERIFIED', async () => {
    const kpis = [makeKpi({ metric: 'no_such_metric', blocking: true })];
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, {
      evaluatedBy: 'auto',
      now: NOW,
      resolver: makeResolver({}),
    });
    expect(state.overall).toBe('UNVERIFIED');
  });
});

// ─── known key with no data ───────────────────────────────────────────────────

describe('evaluateInitiativeKPIs — known key, unavailable data', () => {
  it('returns UNVERIFIED with the unavailable reason when resolver returns unavailable', async () => {
    const kpis = [makeKpi({ metric: 'release.attribution_coverage_pct', operator: 'gte', threshold: 80 })];
    const resolver = makeResolver({
      'release.attribution_coverage_pct': { unavailable: 'no releases exist yet' },
    });
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, {
      evaluatedBy: 'auto',
      now: NOW,
      resolver,
    });
    expect(state.kpis[0].verdict).toBe('UNVERIFIED');
    expect(state.kpis[0].evidence).toBe('no releases exist yet');
    expect(state.kpis[0].observedValue).toBeUndefined();
  });

  it('unavailable blocking KPI drives overall to UNVERIFIED', async () => {
    const kpis = [makeKpi({ metric: 'release.merge_to_healthy_p50_hours', blocking: true })];
    const resolver = makeResolver({
      'release.merge_to_healthy_p50_hours': { unavailable: 'no releases with healthy_at — deploy health tracking not yet active' },
    });
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, {
      evaluatedBy: 'auto',
      now: NOW,
      resolver,
    });
    expect(state.overall).toBe('UNVERIFIED');
  });
});

// ─── passing metric ───────────────────────────────────────────────────────────

describe('evaluateInitiativeKPIs — passing metric', () => {
  it('returns pass verdict and populates observedValue when threshold is met', async () => {
    const kpis = [makeKpi({ metric: 'release.attribution_coverage_pct', operator: 'gte', threshold: 80 })];
    const resolver = makeResolver({ 'release.attribution_coverage_pct': { value: 92.5 } });
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, {
      evaluatedBy: 'manual',
      now: NOW,
      resolver,
    });
    expect(state.kpis[0].verdict).toBe('pass');
    expect(state.kpis[0].observedValue).toBeCloseTo(92.5);
    expect(state.overall).toBe('pass');
  });

  it('pass verdict for all operators: gt', async () => {
    const kpis = [makeKpi({ metric: 'release.oldest_unshipped_age_days', operator: 'lt', threshold: 7 })];
    const resolver = makeResolver({ 'release.oldest_unshipped_age_days': { value: 2 } });
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, { evaluatedBy: 'auto', now: NOW, resolver });
    expect(state.kpis[0].verdict).toBe('pass');
  });

  it('fail verdict when threshold is not met (lt, value > threshold)', async () => {
    const kpis = [makeKpi({ metric: 'release.oldest_unshipped_age_days', operator: 'lt', threshold: 7 })];
    const resolver = makeResolver({ 'release.oldest_unshipped_age_days': { value: 10 } });
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, { evaluatedBy: 'auto', now: NOW, resolver });
    expect(state.kpis[0].verdict).toBe('fail');
    expect(state.kpis[0].observedValue).toBeCloseTo(10);
  });
});

// ─── failing blocking metric drives overall to fail ───────────────────────────

describe('evaluateInitiativeKPIs — blocking failure', () => {
  it('overall=fail when a blocking KPI fails', async () => {
    const kpis = [
      makeKpi({ name: 'Coverage', metric: 'release.attribution_coverage_pct', operator: 'gte', threshold: 90, blocking: true }),
    ];
    const resolver = makeResolver({ 'release.attribution_coverage_pct': { value: 70 } });
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, {
      evaluatedBy: 'auto',
      now: NOW,
      resolver,
    });
    expect(state.kpis[0].verdict).toBe('fail');
    expect(state.overall).toBe('fail');
  });

  it('overall=fail when one blocking KPI fails even if another passes', async () => {
    const kpis = [
      makeKpi({ name: 'Coverage', metric: 'release.attribution_coverage_pct', operator: 'gte', threshold: 90, blocking: true }),
      makeKpi({ name: 'Oldest', metric: 'release.oldest_unshipped_age_days', operator: 'lt', threshold: 14, blocking: true }),
    ];
    const resolver = makeResolver({
      'release.attribution_coverage_pct': { value: 70 },  // fails
      'release.oldest_unshipped_age_days': { value: 3 },   // passes
    });
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, {
      evaluatedBy: 'auto',
      now: NOW,
      resolver,
    });
    expect(state.overall).toBe('fail');
  });
});

// ─── non-blocking failure leaves overall at pass ──────────────────────────────

describe('evaluateInitiativeKPIs — non-blocking failure', () => {
  it('overall=pass when only non-blocking KPIs fail', async () => {
    const kpis = [
      makeKpi({ name: 'Coverage', metric: 'release.attribution_coverage_pct', operator: 'gte', threshold: 90, blocking: false }),
    ];
    const resolver = makeResolver({ 'release.attribution_coverage_pct': { value: 55 } });
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, {
      evaluatedBy: 'auto',
      now: NOW,
      resolver,
    });
    expect(state.kpis[0].verdict).toBe('fail');
    expect(state.overall).toBe('pass');
  });

  it('overall=pass when blocking KPI passes and non-blocking KPI fails', async () => {
    const kpis = [
      makeKpi({ name: 'Coverage', metric: 'release.attribution_coverage_pct', operator: 'gte', threshold: 80, blocking: true }),
      makeKpi({ name: 'Failure rate', metric: 'release.change_failure_rate_pct', operator: 'lte', threshold: 5, blocking: false }),
    ];
    const resolver = makeResolver({
      'release.attribution_coverage_pct': { value: 95 },  // blocking, passes
      'release.change_failure_rate_pct': { value: 25 },   // non-blocking, fails
    });
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, {
      evaluatedBy: 'manual',
      now: NOW,
      resolver,
    });
    expect(state.kpis[0].verdict).toBe('pass');
    expect(state.kpis[1].verdict).toBe('fail');
    expect(state.overall).toBe('pass');
  });
});

// ─── no resolver falls back gracefully ────────────────────────────────────────

describe('evaluateInitiativeKPIs — no resolver', () => {
  it('returns UNVERIFIED for all KPIs when no resolver is provided', async () => {
    const kpis = [makeKpi({ metric: 'release.attribution_coverage_pct' })];
    const state = await evaluateInitiativeKPIs(INIT_ID, kpis, { evaluatedBy: 'auto', now: NOW });
    expect(state.kpis[0].verdict).toBe('UNVERIFIED');
    expect(state.kpis[0].evidence).toMatch(/no resolver/i);
  });
});

// ─── evaluatedAt / evaluatedBy ────────────────────────────────────────────────

describe('evaluateInitiativeKPIs — metadata', () => {
  it('preserves evaluatedAt and evaluatedBy', async () => {
    const state = await evaluateInitiativeKPIs(INIT_ID, [], { evaluatedBy: 'mcp', now: NOW });
    expect(state.evaluatedAt).toBe(NOW);
    expect(state.evaluatedBy).toBe('mcp');
  });

  it('uses current time when now is not provided', async () => {
    const before = Date.now();
    const state = await evaluateInitiativeKPIs(INIT_ID, [], { evaluatedBy: 'auto' });
    const after = Date.now();
    const ts = new Date(state.evaluatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
