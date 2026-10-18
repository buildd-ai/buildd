import { describe, expect, test } from 'bun:test';
import { estimatesReadout, inTen, limitedHistoryLine, typicalBiasLine } from './estimates-view';

const score = (scored: number, withinP80: number | null, medianRatio: number | null = 1) =>
  ({ n: scored, scored, withinP80, medianRatio, medianAbsLogError: 0.2 });
const src = (key: string, scored: number) => ({ key, score: score(scored, scored ? 0.5 : null) });
const view = (overall: ReturnType<typeof score>, bySource = [src('neighbours', overall.scored)]) =>
  estimatesReadout({ overall, bySource });

const NOT_ENOUGH = 'Not enough finished tasks to assess estimates.';

describe('estimatesReadout: insufficient evidence (AC-9)', () => {
  test('0 scored: the lead alone, no count and no rate', () => {
    expect(view(score(0, null, null), [])).toEqual({ lead: NOT_ENOUGH, sample: null, typical: null, limitedHistory: null });
  });
  test('1 scored: singular count, no rate even when it landed within', () => {
    const v = view(score(1, 1));
    expect(v.lead).toBe(NOT_ENOUGH);
    expect(v.sample).toBe('1 finished so far.');
    expect(v.typical).toBeNull();
  });
  test('9 scored: no rate, and no typical line even with a large overrun', () => {
    const v = view(score(9, 0.2, 3));
    expect(v.lead).toBe(NOT_ENOUGH);
    expect(v.sample).toBe('9 finished so far.');
    expect(v.typical).toBeNull();
  });
  test('a missing rate at 10+ is not a result', () => {
    expect(view(score(12, null)).lead).toBe(NOT_ENOUGH);
  });
});

describe('estimatesReadout: a rate from 10 (AC-10)', () => {
  test('10 scored, 7 within: the fraction and the sample, nothing else', () => {
    const v = view(score(10, 0.7));
    expect(v.lead).toBe('Upper estimate coverage: 70% (80% target).');
    expect(v.sample).toBe('Across 10 finished tasks.');
    expect(v.typical).toBe('Actual / p50: 1.0x.');
  });
  test('rounding never turns near-total coverage into all tasks', () => {
    expect(view(score(1000, 0.999)).lead).toBe('Upper estimate coverage: 99% (80% target).');
    expect(view(score(1000, 0.001)).lead).toBe('Upper estimate coverage: 1% (80% target).');
    expect(view(score(1000, 1)).lead).toBe('Upper estimate coverage: 100% (80% target).');
  });
  test('40 scored: the n reads 40', () => {
    expect(view(score(40, 0.85)).sample).toBe('Across 40 finished tasks.');
  });
  test('a weak result reads as its number, with no verdict word', () => {
    const v = view(score(50, 0.3));
    expect(v.lead).toBe('Upper estimate coverage: 30% (80% target).');
    for (const line of Object.values(v)) expect(line ?? '').not.toMatch(/most|almost|many|only|good|great|poor|days|week/i);
  });
});

describe('inTen', () => {
  test('rounds, but never claims all or none it did not see', () => {
    expect(inTen(0.7)).toBe(7);
    expect(inTen(0.85)).toBe(9);
    expect(inTen(0.97)).toBe(9);
    expect(inTen(1)).toBe(10);
    expect(inTen(0.02)).toBe(1);
    expect(inTen(0)).toBe(0);
  });
});

describe('typicalBiasLine (AC-11)', () => {
  test('reports the ratio near one and omits missing or invalid ratios', () => {
    expect(typicalBiasLine(score(20, 0.8, 1))).toBe('Actual / p50: 1.0x.');
    expect(typicalBiasLine(score(20, 0.8, null))).toBeNull();
    expect(typicalBiasLine(score(20, 0.8, 0))).toBeNull();
    expect(typicalBiasLine(score(20, 0.8, NaN))).toBeNull();
    expect(typicalBiasLine(score(20, 0.8, 0.02))).toBe('Actual / p50: <0.1x.');
  });
  test('reports overrun and underrun without reciprocal distortion', () => {
    expect(typicalBiasLine(score(20, 0.5, 1.5))).toBe('Actual / p50: 1.5x.');
    expect(typicalBiasLine(score(20, 0.9, 0.6))).toBe('Actual / p50: 0.6x.');
  });
  test('shown under the rate from 10 scored', () => {
    expect(view(score(10, 0.5, 1.5)).typical).toBe('Actual / p50: 1.5x.');
    expect(view(score(30, 0.95, 0.6)).typical).toBe('Actual / p50: 0.6x.');
  });
});

describe('limited history (AC-13)', () => {
  test('counts estimates that leaned on the new-repo prior or on no evidence, with no rate', () => {
    const line = limitedHistoryLine([src('neighbours', 20), src('prior', 3), src('default', 1)]);
    expect(line).toBe('4 of these had limited comparable history in the repo.');
    expect(line).not.toMatch(/in 10|%|longer|shorter/);
  });
  test('none leaned on them: no line', () => {
    expect(limitedHistoryLine([src('neighbours', 20), src('clusters', 4), src('prior', 0)])).toBeNull();
    expect(limitedHistoryLine([])).toBeNull();
  });
  test('shows below the cut-off too, under the count', () => {
    const v = view(score(3, 0.33), [src('prior', 2), src('neighbours', 1)]);
    expect(v.lead).toBe(NOT_ENOUGH);
    expect(v.limitedHistory).toBe('2 of these had limited comparable history in the repo.');
  });
  test('one reads in the singular', () => {
    expect(limitedHistoryLine([src('prior', 1)])).toBe('1 of these had limited comparable history in the repo.');
  });
});
