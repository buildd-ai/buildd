import { describe, it, expect } from 'bun:test';
import { fmtLevel, levelPaths, levelY, niceScaleMax, scaleTicks } from './occupancy-geometry';

describe('niceScaleMax', () => {
  it('follows the data, so a peak of 1 fills the chart whatever the slot count', () => {
    expect(niceScaleMax([0, 0.3, 1])).toBe(1);
    expect(niceScaleMax([0.2])).toBe(1);
  });
  it('rounds up to a number that labels cleanly', () => {
    expect(niceScaleMax([3.2])).toBe(4);
    expect(niceScaleMax([7])).toBe(8);
    expect(niceScaleMax([10])).toBe(10);
    expect(niceScaleMax([11])).toBe(12);
    expect(niceScaleMax([23])).toBe(30);
  });
  it('takes the highest across every series, and is never 0', () => {
    expect(niceScaleMax([1], [4.5])).toBe(5);
    expect(niceScaleMax([0, 0])).toBe(1);
  });
});

describe('scaleTicks', () => {
  it('adds a middle line only when it is a whole number', () => {
    expect(scaleTicks(4)).toEqual([0, 2, 4]);
    expect(scaleTicks(5)).toEqual([0, 5]);
    expect(scaleTicks(1)).toEqual([0, 1]);
  });
});

describe('fmtLevel', () => {
  it('reads an average under one as <1, keeps one decimal under 10, drops a trailing .0', () => {
    expect(fmtLevel(0)).toBe('0');
    expect(fmtLevel(0.04)).toBe('<1');
    expect(fmtLevel(0.96)).toBe('<1');
    expect(fmtLevel(1.64)).toBe('1.6');
    expect(fmtLevel(2)).toBe('2');
    expect(fmtLevel(12.4)).toBe('12');
  });
});

describe('levelPaths', () => {
  it('is empty for no buckets', () => {
    expect(levelPaths([], 1, 100, 10)).toEqual({ line: '', area: '' });
  });
  it('spans the full width and puts 0 on the baseline and max at the top', () => {
    const { line, area } = levelPaths([0, 2], 2, 100, 10);
    expect(line).toBe('M0,10 L25,10 L75,0 L100,0');
    expect(area.endsWith('L100,10 L0,10 Z')).toBe(true);
  });
  it('clips a value above max to the top instead of drawing outside the box', () => {
    expect(levelY(5, 2, 10)).toBe(0);
  });
});
