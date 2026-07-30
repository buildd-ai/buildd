import { describe, expect, test } from 'bun:test';
import {
  MODEL_WEIGHTS,
  OAUTH_WINDOW_MS,
  inferWindowStart,
  modelWeight,
  summarizeWindowUsage,
} from '../oauth-budget';

const T0 = new Date('2026-07-30T12:00:00.000Z').getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const MIN_PER_WINDOW = OAUTH_WINDOW_MS / 60_000; // 300

describe('inferWindowStart (gap-based sessionization)', () => {
  test('with no history at all, the window opens now', () => {
    const start = inferWindowStart({ now: at(0), lastResetsAt: null, workerStarts: [] });
    expect(start.getTime()).toBe(at(0).getTime());
  });

  test('anchors on the first worker start when there is no prior reset', () => {
    // Sessions open at first use: 09:00 here, so the window runs 09:00–14:00.
    const start = inferWindowStart({
      now: at(0),
      lastResetsAt: null,
      workerStarts: [at(-180), at(-120), at(-30)],
    });
    expect(start.getTime()).toBe(at(-180).getTime());
  });

  test('rolls forward to the first start after the previous window expired', () => {
    // First use at T-400min opens a window that expires at T-100min. The next
    // start after that (T-90min) opens the current window — NOT a rolling 5h,
    // which would have swept in the expired window's workers.
    const start = inferWindowStart({
      now: at(0),
      lastResetsAt: null,
      workerStarts: [at(-400), at(-380), at(-90), at(-10)],
    });
    expect(start.getTime()).toBe(at(-90).getTime());
  });

  test('rolls forward across several expired windows', () => {
    const starts = [at(-1300), at(-1200), at(-900), at(-500), at(-100)];
    const start = inferWindowStart({ now: at(0), lastResetsAt: null, workerStarts: starts });
    // -1300 opens a window ending -1000; -900 opens one ending -600;
    // -500 opens one ending -200; -100 opens the live one.
    expect(start.getTime()).toBe(at(-100).getTime());
  });

  test('a known reset boundary takes precedence over earlier history', () => {
    // Everything before the reset belongs to a dead window and must not count.
    const start = inferWindowStart({
      now: at(0),
      lastResetsAt: at(-60),
      workerStarts: [at(-200), at(-150), at(-45), at(-5)],
    });
    expect(start.getTime()).toBe(at(-45).getTime());
  });

  test('after a reset with no work yet, the window has not opened — measure from now', () => {
    const start = inferWindowStart({
      now: at(0),
      lastResetsAt: at(-30),
      workerStarts: [at(-200)],
    });
    expect(start.getTime()).toBe(at(0).getTime());
  });

  test('a stale reset does not strand the estimate on a rolling window', () => {
    // Reset was 3 days ago; sessionization still finds the live window's start.
    const start = inferWindowStart({
      now: at(0),
      lastResetsAt: at(-4320),
      workerStarts: [at(-4000), at(-800), at(-120), at(-20)],
    });
    expect(start.getTime()).toBe(at(-120).getTime());
  });

  test('never reaches further back than one window length', () => {
    // Continuous work: the live window opened exactly one window ago at most.
    const starts = Array.from({ length: 40 }, (_, i) => at(-MIN_PER_WINDOW * 2 + i * 15));
    const start = inferWindowStart({ now: at(0), lastResetsAt: null, workerStarts: starts });
    expect(at(0).getTime() - start.getTime()).toBeLessThanOrEqual(OAUTH_WINDOW_MS);
  });

  test('ignores future-dated resets and unsorted input', () => {
    const start = inferWindowStart({
      now: at(0),
      lastResetsAt: at(+120),
      workerStarts: [at(-30), at(-200), at(-90)],
    });
    // Unsorted history is sorted internally; -200 opens a window ending +100,
    // so it is still live and -200 is the start.
    expect(start.getTime()).toBe(at(-200).getTime());
  });
});

describe('model weighting', () => {
  test('weights are expressed in sonnet-equivalents', () => {
    expect(modelWeight('claude-sonnet-4-6')).toBe(1);
    expect(modelWeight('claude-opus-4-6')).toBe(MODEL_WEIGHTS.opus);
    expect(modelWeight('claude-haiku-4-5-20251001')).toBe(MODEL_WEIGHTS.haiku);
  });

  test('tier aliases and unknown models resolve sanely', () => {
    expect(modelWeight('opus')).toBe(MODEL_WEIGHTS.opus);
    expect(modelWeight('premium')).toBe(MODEL_WEIGHTS.opus);
    expect(modelWeight('budget')).toBe(MODEL_WEIGHTS.haiku);
    // Unknown / null must not silently count as free, nor as the most expensive.
    expect(modelWeight(null)).toBe(1);
    expect(modelWeight('some-future-model')).toBe(1);
  });

  test('summarizeWindowUsage reports raw and sonnet-equivalent totals', () => {
    const usage = summarizeWindowUsage([
      { model: 'claude-opus-4-6', turns: 10, inputTokens: 1_000, outputTokens: 100 },
      { model: 'claude-sonnet-4-6', turns: 10, inputTokens: 1_000, outputTokens: 100 },
      { model: 'claude-haiku-4-5', turns: 10, inputTokens: 1_000, outputTokens: 100 },
    ]);
    expect(usage.workerCount).toBe(3);
    expect(usage.turns).toBe(30);
    expect(usage.tokens).toBe(3_300);
    // 10*5 + 10*1 + 10*0.27 = 62.7 → floor 62
    expect(usage.weightedTurns).toBe(62);
    // 1100*5 + 1100*1 + 1100*0.27 = 6897
    expect(usage.weightedTokens).toBe(6_897);
  });

  test('a worker that reported nothing still counts as a worker', () => {
    const usage = summarizeWindowUsage([{ model: null, turns: 0, inputTokens: 0, outputTokens: 0 }]);
    expect(usage.workerCount).toBe(1);
    expect(usage.turns).toBe(0);
    expect(usage.weightedTurns).toBe(0);
  });
});
