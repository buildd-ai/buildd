import { describe, it, expect } from 'bun:test';
import { fmtLevel, levelPaths, levelY, occupancyScaleMax } from './occupancy-geometry';

describe('occupancyScaleMax', () => {
  it('is the current slot count when history stayed under it', () => {
    expect(occupancyScaleMax(10, [1, 2, 3], [0, 4])).toBe(10);
  });
  it('rises to the history when it went above today\'s count (a runner since removed)', () => {
    expect(occupancyScaleMax(4, [1, 6.5], [2])).toBe(6.5);
  });
  it('is never 0, so an idle fleet with no runners still draws', () => {
    expect(occupancyScaleMax(0, [0, 0])).toBe(1);
  });
});

describe('fmtLevel', () => {
  it('keeps one decimal under 10 and drops a trailing .0', () => {
    expect(fmtLevel(0)).toBe('0');
    expect(fmtLevel(1.64)).toBe('1.6');
    expect(fmtLevel(2)).toBe('2');
    expect(fmtLevel(0.04)).toBe('0');
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
