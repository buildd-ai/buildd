import { describe, it, expect } from 'bun:test';
import { bandFor, buildBacktestReport, median, scoreRows, type BacktestRow } from '../estimate-backtest';

const row = (o: Partial<BacktestRow>): BacktestRow => ({
  source: 'neighbours', p50: 10, p80: 20, actual: 10, priorCompleted: 0, ...o,
});

describe('scoreRows', () => {
  it('computes coverage, ratio and log error on fixed rows', () => {
    const s = scoreRows([
      row({ actual: 10 }),            // ratio 1, within
      row({ actual: 20 }),            // ratio 2, within (== p80)
      row({ actual: 40 }),            // ratio 4, outside
      row({ actual: 5 }),             // ratio .5, within
    ]);
    expect(s.n).toBe(4);
    expect(s.withinP80).toBe(0.75);
    expect(s.medianRatio).toBe(1.5);
    expect(s.medianAbsLogError).toBeCloseTo(Math.log(2), 10); // |ln| = 0, .69, .69, 1.39
  });

  it('median abs log error is symmetric for over- and under-estimates', () => {
    const s = scoreRows([row({ actual: 20 }), row({ actual: 5 })]);
    expect(s.medianAbsLogError).toBeCloseTo(Math.log(2), 10);
  });

  it('empty input yields nulls, not NaN', () => {
    expect(scoreRows([])).toEqual({ n: 0, scored: 0, withinP80: null, medianRatio: null, medianAbsLogError: null });
  });

  it('rows without p80 are excluded from coverage but still scored on ratio', () => {
    const s = scoreRows([row({ p80: null, actual: 20 })]);
    expect(s.withinP80).toBeNull();
    expect(s.medianRatio).toBe(2);
  });

  it('rows with no estimate or a non-positive actual do not score', () => {
    const s = scoreRows([row({ source: 'none', p50: null, p80: null }), row({ actual: 0 })]);
    expect(s.scored).toBe(0);
    expect(s.medianRatio).toBeNull();
  });
});

describe('buildBacktestReport', () => {
  it('splits by source, leaving empty buckets null', () => {
    const r = buildBacktestReport([row({ source: 'neighbours' }), row({ source: 'bucket', actual: 20 })]);
    expect(r.bySource.neighbours.n).toBe(1);
    expect(r.bySource.bucket.medianRatio).toBe(2);
    expect(r.bySource.none).toEqual({ n: 0, scored: 0, withinP80: null, medianRatio: null, medianAbsLogError: null });
  });

  it('splits the learning curve at the band edges', () => {
    expect([0, 1, 9, 10, 49, 50, 500].map(bandFor)).toEqual(['0', '1-9', '1-9', '10-49', '10-49', '50+', '50+']);
    const r = buildBacktestReport([row({ priorCompleted: 0 }), row({ priorCompleted: 12 }), row({ priorCompleted: 12 })]);
    expect(r.byHistory.map(b => [b.band, b.score.n])).toEqual([['0', 1], ['1-9', 0], ['10-49', 2], ['50+', 0]]);
  });

  it('median of even and empty sets', () => {
    expect(median([])).toBeNull();
    expect(median([1, 3])).toBe(2);
  });
});
