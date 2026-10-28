import { describe, expect, test } from 'bun:test';
import {
  RUNNER_LIVE_WINDOW_MS,
  RUNNER_ONLINE_THRESHOLD_MS,
  RUNNER_RECENTLY_SEEN_MS,
  RUNNER_STALE_CUTOFF_MS,
  beatWithin,
  freeSlots,
  hasFreeSlot,
} from '../src/runner-liveness';

const NOW = Date.parse('2026-10-25T12:00:00Z');

describe('window constants (pinned)', () => {
  test('are derived from the ping and poll cadence', () => {
    expect(RUNNER_LIVE_WINDOW_MS).toBe(180_000);
    expect(RUNNER_RECENTLY_SEEN_MS).toBe(600_000);
    expect(RUNNER_ONLINE_THRESHOLD_MS).toBe(1.5 * 60 * 60_000);
    expect(RUNNER_STALE_CUTOFF_MS).toBe(2.5 * 60 * 60_000);
  });
});

describe('beatWithin', () => {
  test('a beat inside the window counts, at the boundary it does not', () => {
    expect(beatWithin(NOW - 1, NOW, RUNNER_LIVE_WINDOW_MS)).toBe(true);
    expect(beatWithin(NOW - RUNNER_LIVE_WINDOW_MS + 1, NOW, RUNNER_LIVE_WINDOW_MS)).toBe(true);
    expect(beatWithin(NOW - RUNNER_LIVE_WINDOW_MS, NOW, RUNNER_LIVE_WINDOW_MS)).toBe(false);
  });
  test('accepts ISO strings and Dates', () => {
    const t = NOW - 30_000;
    expect(beatWithin(new Date(t), NOW, RUNNER_LIVE_WINDOW_MS)).toBe(true);
    expect(beatWithin(new Date(t).toISOString(), NOW, RUNNER_LIVE_WINDOW_MS)).toBe(true);
  });
  test('an unparseable beat is never within', () => {
    expect(beatWithin('nope', NOW, RUNNER_STALE_CUTOFF_MS)).toBe(false);
  });
});

describe('hasFreeSlot', () => {
  test('is freeSlots > 0', () => {
    expect(hasFreeSlot(3, 2)).toBe(true);
    expect(hasFreeSlot(3, 3)).toBe(false);
    expect(hasFreeSlot(2, 5)).toBe(false);
    expect(hasFreeSlot(0, 0)).toBe(false);
    expect(hasFreeSlot(3, 2)).toBe(freeSlots(3, 2) > 0);
  });
});
