import { describe, it, expect } from 'bun:test';
import { percentile } from '../src/percentile';

describe('percentile (nearest rank, p in 0–100)', () => {
  it('returns null for no values', () => expect(percentile([], 50)).toBeNull());
  it('picks the nearest-rank element', () => {
    const xs = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 90)).toBe(9);
    expect(percentile(xs, 100)).toBe(10);
    expect(percentile(xs, 0)).toBe(1);
  });
  it('never interpolates', () => expect(percentile([1, 2, 3, 4], 50)).toBe(2));
  it('single value and p95 over 1..100', () => {
    expect(percentile([5], 90)).toBe(5);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });
  it('does not mutate its input', () => {
    const xs = [3, 1, 2];
    percentile(xs, 50);
    expect(xs).toEqual([3, 1, 2]);
  });
});
