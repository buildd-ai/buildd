import { describe, expect, it } from 'bun:test';
import { activeWorkMs, describeMissionDuration, formatDuration } from './mission-duration';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

describe('formatDuration', () => {
  it('reads in m / h / d, two units at most, never H:MM:SS', () => {
    expect(formatDuration(30_000)).toBe('<1m');
    expect(formatDuration(42 * MIN)).toBe('42m');
    expect(formatDuration(3 * H + 5 * MIN)).toBe('3h 5m');
    expect(formatDuration(3 * H)).toBe('3h');
    expect(formatDuration(2 * D + 4 * H)).toBe('2d 4h');
    // The owner's case: 855 hours of wall time.
    expect(formatDuration(855 * H + 62_000)).toBe('35d');
  });

  it('treats null and negatives as <1m', () => {
    expect(formatDuration(null)).toBe('<1m');
    expect(formatDuration(-5 * MIN)).toBe('<1m');
  });
});

describe('activeWorkMs', () => {
  it('unions overlapping spans instead of summing them', () => {
    expect(activeWorkMs([{ start: 0, end: 10 * MIN }, { start: 5 * MIN, end: 15 * MIN }], 0)).toBe(15 * MIN);
  });

  it('adds disjoint spans and counts an open span to now', () => {
    expect(activeWorkMs([{ start: 0, end: 20 * MIN }, { start: 30 * D, end: null }], 30 * D + 20 * MIN)).toBe(40 * MIN);
  });

  it('ignores empty and backwards spans', () => {
    expect(activeWorkMs([{ start: 10, end: 10 }, { start: 20, end: 5 }], 0)).toBe(0);
  });
});

describe('describeMissionDuration', () => {
  it('names work and open time when they tell different stories', () => {
    const d = describeMissionDuration({ activeMs: 40 * MIN, openMs: 35 * D });
    expect(d.label).toBe('40m of work · open 35d');
    expect(d.showOpen).toBe(true);
  });

  it('says "took" when the window is about the work', () => {
    expect(describeMissionDuration({ activeMs: 38 * MIN, openMs: 41 * MIN }).label).toBe('took 38m');
    // Twice as long but under an hour more: still just the work.
    expect(describeMissionDuration({ activeMs: 20 * MIN, openMs: 50 * MIN }).label).toBe('took 20m');
  });

  it('falls back to the open span when no agent ran', () => {
    expect(describeMissionDuration({ activeMs: 0, openMs: 3 * D }).label).toBe('open 3d');
    expect(describeMissionDuration({ activeMs: null, openMs: 3 * D }).work).toBeNull();
  });
});
