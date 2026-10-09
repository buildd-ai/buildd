import { describe, it, expect } from 'bun:test';
import { computeTaskEstimateReadout, primarySource, type LiveEstimateRow } from '../task-estimate-accuracy';
import { buildBacktestReport, scoreRows } from '../estimate-backtest';

let n = 0;
const row = (o: Partial<LiveEstimateRow> & { p50Minutes: number; actualMinutes: number }): LiveEstimateRow => ({
  taskId: `t${n++}`, workspaceId: 'w1', estimatorVersion: 'blend-v1',
  p80Minutes: o.p50Minutes * 2, p50Tokens: 100, p80Tokens: 200, expectedRepairs: 0.5,
  actualTokens: 120, actualRepairs: 1, kind: 'engineering',
  explanation: { sources: [{ source: 'neighbours', n: 4, weight: 0.6 }, { source: 'prior', n: 9, weight: 0.4 }], clusterLabel: 'apps/web' },
  priorCompleted: 12,
  ...o,
});

const rows: LiveEstimateRow[] = [
  row({ p50Minutes: 20, actualMinutes: 30 }),
  row({ p50Minutes: 20, actualMinutes: 60, priorCompleted: 0, kind: 'research', explanation: { sources: [{ source: 'prior', n: 9, weight: 1 }], clusterLabel: null } }),
  row({ p50Minutes: 30, actualMinutes: 25, priorCompleted: 55, explanation: { sources: [{ source: 'clusters', n: 5, weight: 0.7 }, { source: 'prior', n: 9, weight: 0.3 }], clusterLabel: 'packages/core' } }),
  row({ p50Minutes: 45, actualMinutes: 200, priorCompleted: 3, explanation: { sources: [], clusterLabel: null } }),
];

describe('computeTaskEstimateReadout', () => {
  it('overall and learning curve equal the backtest scorer on the same rows', () => {
    const r = computeTaskEstimateReadout(rows);
    const direct = rows.map(x => ({ p50: x.p50Minutes, p80: x.p80Minutes, actual: x.actualMinutes }));
    expect(r.overall).toEqual(scoreRows(direct));
    const report = buildBacktestReport(rows.map(x => ({
      source: 'neighbours' as const, p50: x.p50Minutes, p80: x.p80Minutes, actual: x.actualMinutes, priorCompleted: x.priorCompleted,
    })));
    expect(r.byHistory).toEqual(report.byHistory);
  });

  it('reports share within p80 and typical overrun', () => {
    const r = computeTaskEstimateReadout(rows);
    // p80 = 40, 40, 60, 90; actuals 30, 60, 25, 200 → 2 of 4 within
    expect(r.overall.withinP80).toBe(0.5);
    // ratios 1.5, 3, 0.833, 4.44 → median of the middle two
    expect(r.overall.medianRatio).toBeCloseTo((1.5 + 3) / 2, 5);
  });

  it('slices by primary source, kind and cluster, each through the scorer', () => {
    const r = computeTaskEstimateReadout(rows);
    expect(r.bySource.map(g => g.key)).toEqual(['neighbours', 'clusters', 'prior', 'default']);
    expect(r.bySource.find(g => g.key === 'neighbours')!.score).toEqual(scoreRows([{ p50: 20, p80: 40, actual: 30 }]));
    expect(r.byKind.find(g => g.key === 'research')!.score.n).toBe(1);
    expect(r.byCluster.map(g => g.key).sort()).toEqual(['apps/web', 'none', 'packages/core']);
    expect(r.byCluster.find(g => g.key === 'none')!.score.n).toBe(2);
  });

  it('compares expected and actual repairs and scores tokens', () => {
    const r = computeTaskEstimateReadout(rows);
    expect(r.repairs).toEqual({ expected: 0.5, actual: 1 });
    expect(r.tokens.withinP80).toBe(1);
  });

  it('is indeterminate with no rows, not a clean bill', () => {
    const r = computeTaskEstimateReadout([]);
    expect(r.indeterminate).toBe(true);
    expect(r.rows).toBe(0);
    expect(r.repairs).toBeNull();
  });

  it('refuses to pool estimator versions', () => {
    expect(() => computeTaskEstimateReadout([rows[0], { ...rows[1], estimatorVersion: 'blend-v2' }])).toThrow(/per estimator version/);
  });
});

describe('primarySource', () => {
  it('is the heaviest source, or default with none', () => {
    expect(primarySource({ sources: [{ source: 'prior', n: 1, weight: 0.2 }, { source: 'clusters', n: 1, weight: 0.8 }] })).toBe('clusters');
    expect(primarySource({ sources: [] })).toBe('default');
  });
});
