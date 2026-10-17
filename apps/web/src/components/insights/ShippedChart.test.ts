import { describe, it, expect } from 'bun:test';
import { shippedGeometry } from './ShippedChart';
import type { DayBar } from './insights-summary';

const D = 24 * 3_600_000;
const bar = (i: number, over: Partial<DayBar> = {}): DayBar => ({
  start: i * D, end: (i + 1) * D, label: `d${i}`, range: '', partial: false, shipped: i % 4, lost: i % 3, prevShipped: null, prevLost: null, ...over,
});
const days = (n: number) => Array.from({ length: n }, (_, i) => bar(i));

describe('shippedGeometry on a phone width', () => {
  it('7 bars at 360px keep counts and label every bar', () => {
    const g = shippedGeometry(days(7), 360, 180);
    expect(g.showCounts).toBe(true);
    expect(g.bars.every(b => b.label !== null)).toBe(true);
  });

  it('30 bars at 360px drop the counts and thin the labels, always keeping the newest', () => {
    const g = shippedGeometry(days(30), 360, 180);
    expect(g.showCounts).toBe(false);
    expect(g.bars.at(-1)!.label).toBe('d29');
    expect(g.bars.filter(b => b.label).length).toBeLessThan(30);
    expect(g.bars.every(b => b.x >= g.plot.left && b.x <= g.plot.right)).toBe(true);
  });

  it('carries the partial flag through so the bar can be drawn as such', () => {
    const g = shippedGeometry([bar(0), bar(1, { partial: true })], 360, 180);
    expect(g.bars.map(b => b.partial)).toEqual([false, true]);
  });
});
