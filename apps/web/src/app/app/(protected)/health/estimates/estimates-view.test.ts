import { describe, expect, test } from 'bun:test';
import { estimatesHeadline, typicalLine, logPos, scatterBounds, medianBandRatio } from './estimates-view';

const score = (scored: number, withinP80: number | null, medianRatio: number | null = 1) =>
  ({ n: scored, scored, withinP80, medianRatio, medianAbsLogError: 0.2 });

describe('estimatesHeadline', () => {
  test('9 in 10 reads as most within estimate, with the basis', () => {
    const h = estimatesHeadline(score(120, 0.9));
    expect(h.lead).toBe('Most tasks finished within estimate.');
    expect(h.basis).toBe('9 in 10 finished within the upper estimate. Based on 120 tasks.');
  });
  test('low coverage says so', () => {
    expect(estimatesHeadline(score(50, 0.4)).lead).toBe('Many tasks ran past their estimate.');
  });
  test('too few tasks is not a verdict', () => {
    expect(estimatesHeadline(score(3, 1)).lead).toMatch(/Not enough/);
    expect(estimatesHeadline(score(0, null)).basis).toBeNull();
  });
});

describe('helpers', () => {
  test('typicalLine', () => {
    expect(typicalLine(score(20, 0.8, 1.05))).toBe('on target');
    expect(typicalLine(score(20, 0.8, 1.9))).toBe('1.9x longer');
    expect(typicalLine(score(20, 0.8, 0.5))).toBe('2.0x shorter');
    expect(typicalLine(score(0, null, null))).toBe('n/a');
  });
  test('log position and bounds', () => {
    expect(logPos(10, 1, 100)).toBeCloseTo(0.5);
    const b = scatterBounds([{ estimate: 5, actual: 300 }]);
    expect(b.lo).toBe(5);
    expect(b.hi).toBe(300);
    expect(scatterBounds([])).toEqual({ lo: 1, hi: 100 });
  });
  test('medianBandRatio', () => {
    expect(medianBandRatio([{ p50: 10, p80: 20 }, { p50: 10, p80: 15 }, { p50: 10, p80: 30 }])).toBe(2);
    expect(medianBandRatio([])).toBe(1.5);
  });
});
