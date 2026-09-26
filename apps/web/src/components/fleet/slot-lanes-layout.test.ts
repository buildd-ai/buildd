import { describe, expect, it } from 'bun:test';
import { assignSlots, axisFraction, axisTicks, fitLaneWindowStart, formatAxisMinutes, LANE_WINDOW_MIN_SPAN_MS, occupiedSlots } from './slot-lanes-layout';

const m = (min: number) => min * 60_000;

describe('assignSlots', () => {
  it('puts non-overlapping spans on one slot', () => {
    const a = assignSlots([
      { id: 'a', start: m(0), end: m(5) },
      { id: 'b', start: m(5), end: m(9) },
    ]);
    expect(a.slots).toBe(1);
    expect(a.slotOf.get('b')).toBe(0);
  });

  it('opens a second slot for an overlap and reuses the lowest free one', () => {
    const a = assignSlots([
      { id: 'a', start: m(0), end: m(10) },
      { id: 'b', start: m(2), end: m(4) },
      { id: 'c', start: m(5), end: null },
    ]);
    expect(a.slots).toBe(2);
    expect(a.slotOf.get('b')).toBe(1);
    // b freed slot 1 at 4m; a still holds slot 0 at 5m.
    expect(a.slotOf.get('c')).toBe(1);
  });

  it('an open span holds its slot for good', () => {
    const a = assignSlots([
      { id: 'live', start: m(0), end: null },
      { id: 'later', start: m(30), end: m(31) },
    ]);
    expect(a.slotOf.get('later')).toBe(1);
  });

  it('is independent of input order', () => {
    const spans = [
      { id: 'x', start: m(1), end: m(3) },
      { id: 'y', start: m(1), end: m(2) },
      { id: 'z', start: m(0), end: m(4) },
    ];
    const one = assignSlots(spans);
    const two = assignSlots([...spans].reverse());
    expect([...one.slotOf.entries()].sort()).toEqual([...two.slotOf.entries()].sort());
  });

  it('draws one empty slot for an empty lane', () => {
    const a = assignSlots([]);
    expect(a.slots).toBe(1);
    expect(a.bySlot).toEqual([[]]);
  });
});

describe('occupiedSlots', () => {
  it('reports what holds each slot at a moment', () => {
    const a = assignSlots([
      { id: 'a', start: m(0), end: m(10) },
      { id: 'b', start: m(2), end: m(4) },
    ]);
    expect(occupiedSlots(a, m(3)).map(s => s?.id ?? null)).toEqual(['a', 'b']);
    expect(occupiedSlots(a, m(5)).map(s => s?.id ?? null)).toEqual(['a', null]);
  });
});

describe('axis', () => {
  it('clamps fractions', () => {
    expect(axisFraction(5, 0, 10)).toBe(0.5);
    expect(axisFraction(-1, 0, 10)).toBe(0);
    expect(axisFraction(11, 0, 10)).toBe(1);
    expect(axisFraction(3, 5, 5)).toBe(0);
  });

  it('picks a tick step that keeps labels under the cap', () => {
    expect(axisTicks(m(20)).stepMin).toBe(2);
    expect(axisTicks(m(38)).stepMin).toBe(5);
    expect(axisTicks(m(20)).ticks[0]).toBe(0);
  });

  it('formats minutes', () => {
    expect(formatAxisMinutes(12)).toBe('12m');
    expect(formatAxisMinutes(120)).toBe('2h');
    expect(formatAxisMinutes(90)).toBe('1h 30m');
    expect(formatAxisMinutes(2880)).toBe('2d');
  });
});

describe('fitLaneWindowStart', () => {
  const NOW = Date.UTC(2026, 0, 10, 14, 12);
  const minAgo = (n: number) => NOW - n * 60_000;

  it('a fleet that started two minutes ago gets the small minimum span, not half an hour', () => {
    const from = fitLaneWindowStart({ earliest: minAgo(2), now: NOW });
    expect(NOW - from).toBeGreaterThanOrEqual(LANE_WINDOW_MIN_SPAN_MS);
    expect(NOW - from).toBeLessThan(12 * 60_000);
    expect(LANE_WINDOW_MIN_SPAN_MS).toBe(10 * 60_000);
  });

  it('starts just before the earliest bar, on a whole axis step', () => {
    const from = fitLaneWindowStart({ earliest: minAgo(47), now: NOW });
    expect(from).toBeLessThan(minAgo(47));
    expect(from).toBeGreaterThanOrEqual(minAgo(55));
    const { stepMin } = axisTicks(NOW - from, 10);
    expect(from % (stepMin * 60_000)).toBe(0);
  });

  it('never reaches back past the cap', () => {
    const from = fitLaneWindowStart({ earliest: minAgo(20 * 60), now: NOW, maxSpanMs: 8 * 3_600_000 });
    expect(from).toBeGreaterThanOrEqual(NOW - 8 * 3_600_000);
    expect(from).toBeLessThan(NOW - 7 * 3_600_000);
  });

  it('no bars: the minimum span ending now', () => {
    expect(NOW - fitLaneWindowStart({ earliest: null, now: NOW })).toBeGreaterThanOrEqual(LANE_WINDOW_MIN_SPAN_MS);
    expect(NOW - fitLaneWindowStart({ earliest: null, now: NOW })).toBeLessThan(12 * 60_000);
  });

  it('snaps relative to an anchor, and never before the anchor when the data does not', () => {
    const anchor = minAgo(33) + 17_000;
    const from = fitLaneWindowStart({ earliest: anchor + 60_000, now: NOW, anchor });
    expect(from).toBe(anchor);
  });
});
