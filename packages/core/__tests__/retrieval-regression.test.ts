import { describe, it, expect } from 'bun:test';
import {
  compareMetrics,
  formatRegressionReport,
  DEFAULT_REGRESSION_THRESHOLD,
  type AggregateMetrics,
} from '../eval/regression';

const BASE: AggregateMetrics = { recallAt5: 0.5, recallAt10: 0.6, mrr: 0.4, ndcg10: 0.45 };

describe('compareMetrics', () => {
  it('passes when current equals baseline', () => {
    const r = compareMetrics(BASE, BASE);
    expect(r.pass).toBe(true);
    expect(r.regressions).toHaveLength(0);
    expect(r.threshold).toBe(DEFAULT_REGRESSION_THRESHOLD);
    expect(r.comparisons).toHaveLength(4);
  });

  it('passes when every metric improves', () => {
    const current: AggregateMetrics = { recallAt5: 0.7, recallAt10: 0.8, mrr: 0.6, ndcg10: 0.7 };
    const r = compareMetrics(current, BASE);
    expect(r.pass).toBe(true);
    expect(r.comparisons.every(c => (c.relativeDelta ?? 0) > 0)).toBe(true);
  });

  it('fails when a metric drops by more than the default 20% threshold', () => {
    // recallAt5 0.5 → 0.35 is a 30% relative drop
    const current: AggregateMetrics = { ...BASE, recallAt5: 0.35 };
    const r = compareMetrics(current, BASE);
    expect(r.pass).toBe(false);
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0].metric).toBe('recallAt5');
    expect(r.regressions[0].relativeDelta).toBeCloseTo(-0.3, 5);
  });

  it('treats an exactly-threshold drop as a pass (boundary is inclusive)', () => {
    // 0.5 → 0.4 is exactly -20%
    const current: AggregateMetrics = { ...BASE, recallAt5: 0.4 };
    const r = compareMetrics(current, BASE);
    expect(r.pass).toBe(true);
    expect(r.regressions).toHaveLength(0);
  });

  it('fails on a drop just beyond the threshold', () => {
    // 0.5 → 0.399 is -20.2%
    const current: AggregateMetrics = { ...BASE, recallAt5: 0.399 };
    const r = compareMetrics(current, BASE);
    expect(r.pass).toBe(false);
    expect(r.regressions[0].metric).toBe('recallAt5');
  });

  it('respects a custom threshold', () => {
    // 0.5 → 0.45 is -10%: regresses at 5% threshold, passes at 20%
    const current: AggregateMetrics = { ...BASE, recallAt5: 0.45 };
    expect(compareMetrics(current, BASE, 0.05).pass).toBe(false);
    expect(compareMetrics(current, BASE, 0.2).pass).toBe(true);
  });

  it('never regresses when baseline metric is 0 (no floor to fall below)', () => {
    const baseline: AggregateMetrics = { recallAt5: 0, recallAt10: 0, mrr: 0, ndcg10: 0 };
    const current: AggregateMetrics = { recallAt5: 0, recallAt10: 0, mrr: 0, ndcg10: 0 };
    const r = compareMetrics(current, baseline);
    expect(r.pass).toBe(true);
    expect(r.comparisons.every(c => c.relativeDelta === null && !c.regressed)).toBe(true);
  });

  it('reports a baseline-0 → positive as a non-regressing improvement', () => {
    const baseline: AggregateMetrics = { recallAt5: 0, recallAt10: 0.6, mrr: 0.4, ndcg10: 0.45 };
    const current: AggregateMetrics = { ...baseline, recallAt5: 0.3 };
    const r = compareMetrics(current, baseline);
    expect(r.pass).toBe(true);
    const r5 = r.comparisons.find(c => c.metric === 'recallAt5')!;
    expect(r5.relativeDelta).toBeNull();
    expect(r5.regressed).toBe(false);
  });

  it('skips a metric absent from either side (optional ndcg10)', () => {
    const current: Partial<AggregateMetrics> = { recallAt5: 0.5, recallAt10: 0.6, mrr: 0.4 };
    const baseline: Partial<AggregateMetrics> = { recallAt5: 0.5, recallAt10: 0.6, mrr: 0.4 };
    const r = compareMetrics(current, baseline);
    expect(r.comparisons).toHaveLength(3);
    expect(r.comparisons.some(c => c.metric === 'ndcg10')).toBe(false);
  });

  it('collects multiple regressions', () => {
    const current: AggregateMetrics = { recallAt5: 0.1, recallAt10: 0.1, mrr: 0.4, ndcg10: 0.45 };
    const r = compareMetrics(current, BASE);
    expect(r.pass).toBe(false);
    expect(r.regressions.map(c => c.metric).sort()).toEqual(['recallAt10', 'recallAt5']);
  });

  it('ignores NaN/Infinity metric values rather than crashing', () => {
    const current: Partial<AggregateMetrics> = { recallAt5: NaN, recallAt10: 0.6, mrr: 0.4 };
    const r = compareMetrics(current, BASE);
    expect(r.comparisons.some(c => c.metric === 'recallAt5')).toBe(false);
    expect(r.pass).toBe(true);
  });

  it('throws on an invalid threshold', () => {
    expect(() => compareMetrics(BASE, BASE, -0.1)).toThrow();
    expect(() => compareMetrics(BASE, BASE, NaN)).toThrow();
  });
});

describe('formatRegressionReport', () => {
  it('renders PASS with each metric and no regression footer', () => {
    const out = formatRegressionReport(compareMetrics(BASE, BASE));
    expect(out).toContain('PASS');
    expect(out).toContain('recallAt5');
    expect(out).toContain('mrr');
    expect(out).not.toContain('REGRESSED');
  });

  it('renders FAIL and flags the regressed metric', () => {
    const current: AggregateMetrics = { ...BASE, mrr: 0.1 };
    const out = formatRegressionReport(compareMetrics(current, BASE));
    expect(out).toContain('FAIL');
    expect(out).toContain('REGRESSED');
    expect(out).toContain('regressed beyond');
  });
});
