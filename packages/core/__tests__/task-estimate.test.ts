/**
 * Blended task estimate (packages/core/task-estimate.ts): prior weight decay,
 * cold start, p80 >= p50, source weights, log-space blend, prior table shape,
 * and the no-evidence default.
 */
import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_ESTIMATE,
  ESTIMATOR_VERSION,
  estimateTask,
  formatEstimateSummary,
  lookupPrior,
  priorWeightFor,
  type ClusterEvidence,
  type EstimateInputs,
  type NeighbourEvidence,
  type PriorCell,
  type PriorTable,
} from '../task-estimate';

const cell = (p50m: number, p80m: number, p50t: number, p80t: number, repairs = 0.2, n = 100): PriorCell => ({
  n, p50Minutes: p50m, p80Minutes: p80m, p50Tokens: p50t, p80Tokens: p80t, repairsPerTask: repairs,
});

const PRIOR: PriorTable = {
  engineering: {
    S: cell(15, 30, 60_000, 120_000, 0.1),
    M: cell(45, 80, 150_000, 280_000, 0.4),
    L: cell(120, 240, 400_000, 800_000, 1.2),
  },
  research: { M: cell(30, 60, 100_000, 200_000, 0) },
};

const nbs = (n: number, p50 = 20, p80 = 40): NeighbourEvidence => ({
  n, p50Minutes: p50, p80Minutes: p80, p50Tokens: 80_000, p80Tokens: 160_000,
});
const cls = (n: number, label: string | null = 'apps/web/missions', p50 = 30): ClusterEvidence => ({
  n, label, p50Minutes: p50, p80Minutes: p50 * 2, p50Tokens: 90_000, p80Tokens: 180_000, repairsPerTask: 1,
});

const base = (over: Partial<EstimateInputs> = {}): EstimateInputs => ({
  kind: 'engineering', bucket: 'M', neighbours: null, clusters: null, prior: PRIOR, k0: 5, ...over,
});

describe('task-estimate', () => {
  it('has a version tag', () => {
    expect(ESTIMATOR_VERSION).toBe('blend-v1');
  });

  it('prior weight falls as n grows', () => {
    expect(priorWeightFor(0, 5)).toBe(1);
    expect(priorWeightFor(5, 5)).toBe(0.5);
    expect(priorWeightFor(10_000, 5)).toBeLessThan(0.001);
    expect(estimateTask(base({ neighbours: nbs(5) })).explanation.priorWeight).toBe(0.5);
    const weights = [1, 3, 10, 50, 500].map((n) => estimateTask(base({ neighbours: nbs(n) })).explanation.priorWeight);
    for (let i = 1; i < weights.length; i++) expect(weights[i]).toBeLessThan(weights[i - 1]);
  });

  it('cold start uses the prior only', () => {
    const r = estimateTask(base());
    expect(r.explanation.priorWeight).toBe(1);
    expect(r.explanation.sources).toEqual([{ source: 'prior', n: 100, weight: 1 }]);
    expect(r.p50Minutes).toBeCloseTo(45);
    expect(r.p80Minutes).toBeCloseTo(80);
    expect(r.p50Tokens).toBeCloseTo(150_000);
    expect(r.expectedRepairs).toBeCloseTo(0.4);
    expect(r.explanation.summary).toBe('45m (25-80m), 150k tokens, from typical engineering tasks; no history in this repo yet.');
  });

  it('falls back to the kind M cell, then any kind cell, then a global average', () => {
    expect(lookupPrior(PRIOR, 'engineering', 'L')!.p50Minutes).toBe(120);
    expect(lookupPrior(PRIOR, 'engineering', null)!.p50Minutes).toBe(45);
    expect(lookupPrior({ ops: { S: cell(10, 20, 1, 2) } }, 'ops', 'L')!.p50Minutes).toBe(10);
    const global = lookupPrior(PRIOR, 'unknown-kind', 'M')!;
    expect(global.p50Minutes).toBeGreaterThan(15);
    expect(global.p50Minutes).toBeLessThan(120);
  });

  it('p80 >= p50 always', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 200; i++) {
      const p = cell(1 + rand() * 100, 1 + rand() * 100, 1 + rand() * 1e6, 1 + rand() * 1e6);
      const r = estimateTask({
        kind: 'k', bucket: 'M', k0: rand() * 20,
        prior: rand() < 0.2 ? {} : { k: { M: p } },
        neighbours: rand() < 0.5 ? null : { n: Math.ceil(rand() * 10), p50Minutes: 1 + rand() * 100, p80Minutes: 1 + rand() * 100, p50Tokens: 1 + rand() * 1e6, p80Tokens: 1 + rand() * 1e6 },
        clusters: rand() < 0.5 ? null : { n: Math.ceil(rand() * 30), label: null, p50Minutes: 1 + rand() * 100, p80Minutes: 1 + rand() * 100, p50Tokens: 1 + rand() * 1e6, p80Tokens: 1 + rand() * 1e6, repairsPerTask: rand() * 3 },
      });
      expect(r.p80Minutes).toBeGreaterThanOrEqual(r.p50Minutes);
      expect(r.p80Tokens).toBeGreaterThanOrEqual(r.p50Tokens);
      expect(Number.isFinite(r.p50Minutes)).toBe(true);
    }
  });

  it('explanation lists every source used and weights sum to 1', () => {
    const r = estimateTask(base({ neighbours: nbs(5), clusters: cls(15) }));
    const names = r.explanation.sources.map((s) => s.source).sort();
    expect(names).toEqual(['clusters', 'neighbours', 'prior']);
    const sum = r.explanation.sources.reduce((s, x) => s + x.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
    // n_local = 20, k0 = 5: local 0.8 split 5:15
    const w = Object.fromEntries(r.explanation.sources.map((s) => [s.source, s.weight]));
    expect(w.neighbours).toBeCloseTo(0.2);
    expect(w.clusters).toBeCloseTo(0.6);
    expect(w.prior).toBeCloseTo(0.2);
    expect(r.explanation.clusterLabel).toBe('apps/web/missions');
    expect(r.explanation.summary).toBe('30m (15-60m), 97k tokens, from 5 similar tasks and work in apps/web/missions, plus typical engineering tasks.');

    const local = estimateTask(base({ prior: {}, neighbours: nbs(3) }));
    expect(local.explanation.sources).toEqual([{ source: 'neighbours', n: 3, weight: 1 }]);
    expect(local.explanation.priorWeight).toBe(0);
  });

  it('log-space blend is between local and prior', () => {
    const r = estimateTask(base({ neighbours: nbs(5, 10, 20) }));
    // equal weights: geometric mean of 10 and 45
    expect(r.p50Minutes).toBeCloseTo(Math.sqrt(10 * 45), 6);
    expect(r.p50Minutes).toBeGreaterThan(10);
    expect(r.p50Minutes).toBeLessThan(45);
    expect(r.p50Minutes).toBeLessThan((10 + 45) / 2);
    expect(r.p50Tokens).toBeGreaterThan(80_000);
    expect(r.p50Tokens).toBeLessThan(150_000);
  });

  it('blends repairs linearly from clusters and the prior', () => {
    const r = estimateTask(base({ clusters: cls(5) }));
    expect(r.expectedRepairs).toBeCloseTo(0.5 * 1 + 0.5 * 0.4);
  });

  it('PriorTable carries no strings beyond enum keys', () => {
    // compile-time: a string leaf must not type-check
    // @ts-expect-error label is not a PriorCell field
    const bad: PriorCell = { ...cell(1, 2, 3, 4), label: 'apps/web' };
    void bad;
    // runtime: kind -> bucket (enum) -> cell; every leaf is a number
    const leaves: unknown[] = [];
    const walk = (v: unknown, depth: number): void => {
      if (v === null || typeof v !== 'object') {
        leaves.push(v);
        return;
      }
      for (const [k, child] of Object.entries(v)) {
        if (depth === 1) expect(['S', 'M', 'L']).toContain(k);
        walk(child, depth + 1);
      }
    };
    walk(PRIOR, 0);
    expect(leaves.length).toBe(4 * 6);
    for (const leaf of leaves) expect(typeof leaf).toBe('number');
  });

  it('no evidence at all returns the documented default', () => {
    const r = estimateTask(base({ prior: {} }));
    expect(r.p50Minutes).toBe(DEFAULT_ESTIMATE.p50Minutes);
    expect(r.p80Minutes).toBe(DEFAULT_ESTIMATE.p80Minutes);
    expect(r.p50Tokens).toBe(DEFAULT_ESTIMATE.p50Tokens);
    expect(r.p80Tokens).toBe(DEFAULT_ESTIMATE.p80Tokens);
    expect(r.expectedRepairs).toBe(DEFAULT_ESTIMATE.expectedRepairs);
    expect(r.explanation.priorWeight).toBe(1);
    expect(r.explanation.sources).toEqual([]);
    expect(r.explanation.summary).toContain('default estimate');
    // n=0 evidence counts as no evidence
    expect(estimateTask(base({ prior: {}, neighbours: nbs(0) })).explanation.sources).toEqual([]);
  });

  it('summary is one plain sentence with no banned words or em dashes', () => {
    const cases = [
      estimateTask(base()),
      estimateTask(base({ prior: {} })),
      estimateTask(base({ neighbours: nbs(1), clusters: cls(4, null), kind: null })),
      estimateTask(base({ prior: {}, clusters: cls(8) })),
    ];
    for (const r of cases) {
      const s = r.explanation.summary;
      expect(s).not.toMatch(/late|\u2014|about|roughly|maybe|probably|might/i);
      expect(s.endsWith('.')).toBe(true);
      expect(s.split('. ').length).toBe(1);
    }
    expect(cases[3].explanation.summary).toBe('30m (15-60m), 90k tokens, from work in apps/web/missions.');
    const { explanation, ...rest } = cases[0];
    const { summary, ...e } = explanation;
    expect(formatEstimateSummary(rest, e, 'engineering')).toBe(summary);
  });
});
