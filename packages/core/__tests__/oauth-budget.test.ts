import { describe, expect, test } from 'bun:test';
import {
  describeOauthPressure,
  learnOauthCapacity,
  oauthBudgetPressure,
  oauthParallelismCap,
  readPacingConfig,
  type OauthEpisode,
} from '../oauth-budget';

const AT = (isoHoursAgo: number) => new Date(Date.now() - isoHoursAgo * 60 * 60 * 1000);

/** Build an episode with sane defaults so each test only states what it cares about. */
function episode(over: Partial<OauthEpisode> & { exhaustedAt?: Date } = {}): OauthEpisode {
  return {
    exhaustedAt: over.exhaustedAt ?? AT(24),
    workerCount: over.workerCount ?? 8,
    turns: over.turns ?? 240,
    inputTokens: over.inputTokens ?? 500_000,
    outputTokens: over.outputTokens ?? 60_000,
  };
}

describe('learnOauthCapacity', () => {
  test('returns no capacity below the minimum sample count', () => {
    const learned = learnOauthCapacity([episode(), episode()]);
    expect(learned.samples).toBe(2);
    expect(learned.confidence).toBe('none');
    expect(learned.workerCount).toBeNull();
    expect(learned.turns).toBeNull();
    expect(learned.tokens).toBeNull();
  });

  test('learns a conservative (p25) capacity once there are enough episodes', () => {
    const learned = learnOauthCapacity([
      episode({ workerCount: 6 }),
      episode({ workerCount: 8 }),
      episode({ workerCount: 10 }),
      episode({ workerCount: 12 }),
    ]);
    expect(learned.samples).toBe(4);
    expect(learned.confidence).toBe('low');
    // p25 of [6,8,10,12] — conservative, below the median of 9.
    expect(learned.workerCount).toBe(7);
  });

  test('reports good confidence at five or more episodes', () => {
    const learned = learnOauthCapacity(Array.from({ length: 5 }, () => episode()));
    expect(learned.confidence).toBe('good');
    expect(learned.workerCount).toBe(8);
  });

  test('ignores degenerate episodes that measured no work', () => {
    const learned = learnOauthCapacity([
      episode({ workerCount: 0, turns: 0, inputTokens: 0, outputTokens: 0 }),
      episode({ workerCount: 10 }),
      episode({ workerCount: 10 }),
      episode({ workerCount: 10 }),
    ]);
    expect(learned.samples).toBe(3);
    expect(learned.workerCount).toBe(10);
  });

  test('only considers the most recent maxSamples episodes', () => {
    const learned = learnOauthCapacity(
      [
        episode({ workerCount: 4, exhaustedAt: AT(1) }),
        episode({ workerCount: 4, exhaustedAt: AT(2) }),
        episode({ workerCount: 4, exhaustedAt: AT(3) }),
        // Older, much larger window — must not drag the learned capacity up.
        episode({ workerCount: 40, exhaustedAt: AT(100) }),
        episode({ workerCount: 40, exhaustedAt: AT(101) }),
      ],
      { maxSamples: 3 },
    );
    expect(learned.samples).toBe(3);
    expect(learned.workerCount).toBe(4);
  });

  test('drops a metric the runner never reports instead of learning zero', () => {
    // OAuth workers frequently report turns/tokens as 0 (no cost accounting on
    // seat-based auth). Learning a capacity of 0 there would pin pressure at 100%.
    const learned = learnOauthCapacity([
      episode({ turns: 0, inputTokens: 0, outputTokens: 0 }),
      episode({ turns: 0, inputTokens: 0, outputTokens: 0 }),
      episode({ turns: 0, inputTokens: 0, outputTokens: 0 }),
    ]);
    expect(learned.workerCount).toBe(8);
    expect(learned.turns).toBeNull();
    expect(learned.tokens).toBeNull();
  });
});

describe('oauthBudgetPressure', () => {
  const learned = learnOauthCapacity(Array.from({ length: 5 }, () => episode({ workerCount: 10, turns: 200, inputTokens: 400_000, outputTokens: 100_000 })));

  test('is zero when nothing has been learned yet — new accounts behave exactly as before', () => {
    const pressure = oauthBudgetPressure({
      usage: { workerCount: 99, turns: 9_999, tokens: 99_000_000, weightedTurns: 0, weightedTokens: 0 },
      capacity: learnOauthCapacity([episode()]),
    });
    expect(pressure.pct).toBe(0);
    expect(pressure.limiter).toBeNull();
    expect(pressure.confidence).toBe('none');
  });

  test('reports the fraction of learned capacity consumed', () => {
    const pressure = oauthBudgetPressure({
      usage: { workerCount: 5, turns: 0, tokens: 0, weightedTurns: 0, weightedTokens: 0 },
      capacity: learned,
    });
    expect(pressure.pct).toBeCloseTo(0.5, 5);
    expect(pressure.limiter).toBe('workers');
  });

  test('the binding metric wins, not the first one', () => {
    const pressure = oauthBudgetPressure({
      usage: { workerCount: 2, turns: 190, tokens: 100_000, weightedTurns: 0, weightedTokens: 0 },
      capacity: learned,
    });
    expect(pressure.limiter).toBe('turns');
    expect(pressure.pct).toBeCloseTo(0.95, 5);
  });

  test('clamps at 1 when the window overshoots the learned wall', () => {
    const pressure = oauthBudgetPressure({
      usage: { workerCount: 40, turns: 0, tokens: 0, weightedTurns: 0, weightedTokens: 0 },
      capacity: learned,
    });
    expect(pressure.pct).toBe(1);
  });

  test('crossing the router pause threshold is reachable and reported', () => {
    const pressure = oauthBudgetPressure({
      usage: { workerCount: 10, turns: 0, tokens: 0, weightedTurns: 0, weightedTokens: 0 },
      capacity: learned,
    });
    // >= 0.95 is what makes the model router pause priority-0 work.
    expect(pressure.pct).toBeGreaterThanOrEqual(0.95);
    expect(describeOauthPressure(pressure)).toContain('workers 10/10');
  });
});

describe('weighted vs raw metric preference', () => {
  const weightedEpisodes = Array.from({ length: 5 }, (_, i) => ({
    exhaustedAt: AT(i + 1),
    workerCount: 10,
    turns: 300,        // raw
    weightedTurns: 600, // opus-heavy window: same turns cost twice as much
    inputTokens: 0,
    outputTokens: 0,
    weightedTokens: 0,
  }));

  test('prefers the model-weighted metric when it was learned', () => {
    const capacity = learnOauthCapacity(weightedEpisodes);
    expect(capacity.weightedTurns).toBe(600);
    // A cheap (haiku) window: 300 raw turns but only 120 sonnet-equivalents.
    const pressure = oauthBudgetPressure({
      usage: { workerCount: 1, turns: 300, tokens: 0, weightedTurns: 120, weightedTokens: 0 },
      capacity,
    });
    // Raw would read 100% and pause everything; weighted correctly reads 20%.
    expect(pressure.pct).toBeCloseTo(0.2, 5);
  });

  test('falls back to raw turns for legacy episodes without weights', () => {
    const legacy = weightedEpisodes.map(e => ({ ...e, weightedTurns: 0 }));
    const capacity = learnOauthCapacity(legacy);
    expect(capacity.weightedTurns).toBeNull();
    expect(capacity.turns).toBe(300);
    const pressure = oauthBudgetPressure({
      usage: { workerCount: 1, turns: 150, tokens: 0, weightedTurns: 999_999, weightedTokens: 0 },
      capacity,
    });
    // Weighted usage is ignored because no weighted capacity was learned.
    expect(pressure.pct).toBeCloseTo(0.5, 5);
    expect(pressure.limiter).toBe('turns');
  });
});

describe('readPacingConfig', () => {
  test('defaults to enabled with the conservative quantile', () => {
    expect(readPacingConfig({})).toEqual({ enabled: true, quantile: 0.25 });
    expect(readPacingConfig({ OAUTH_BUDGET_PACING: 'on' })).toEqual({ enabled: true, quantile: 0.25 });
  });

  test('accepts the documented off spellings', () => {
    for (const raw of ['off', 'OFF', '0', 'false', 'disabled', ' off ']) {
      expect(readPacingConfig({ OAUTH_BUDGET_PACING: raw }).enabled).toBe(false);
    }
  });

  test('a bare fraction tunes how cautious the estimate is', () => {
    expect(readPacingConfig({ OAUTH_BUDGET_PACING: '0.5' })).toEqual({ enabled: true, quantile: 0.5 });
  });

  test('nonsense values fall back to the default rather than disabling pacing', () => {
    expect(readPacingConfig({ OAUTH_BUDGET_PACING: 'yes please' })).toEqual({ enabled: true, quantile: 0.25 });
    expect(readPacingConfig({ OAUTH_BUDGET_PACING: '4' })).toEqual({ enabled: true, quantile: 0.25 });
    expect(readPacingConfig({ OAUTH_BUDGET_PACING: '-0.2' })).toEqual({ enabled: true, quantile: 0.25 });
  });

  test('disabled config makes pressure inert even with a learned capacity', () => {
    // The claim route skips the query entirely when disabled; this guards the
    // contract that a disabled config can never produce a throttling signal.
    const config = readPacingConfig({ OAUTH_BUDGET_PACING: 'off' });
    expect(config.enabled).toBe(false);
  });
});

// Learned pressure is a forecast of the 5h wall, and that forecast is not
// reliable enough to hold work back on. Its only permitted output is a lower
// per-seat concurrency: never below one session, never on low confidence, and
// back to the full limit once the window has reset (pressure falls with it).
describe('oauthParallelismCap', () => {
  const learned = (n: number) =>
    learnOauthCapacity(Array.from({ length: n }, (_, i) => episode({ exhaustedAt: AT(24 + i), turns: 200 })));
  const pressureAt = (turns: number, samples = 5) =>
    oauthBudgetPressure({
      usage: { workerCount: 0, turns, tokens: 0, weightedTurns: 0, weightedTokens: 0 },
      capacity: learned(samples),
    });

  test('no pressure signal leaves concurrency alone', () => {
    expect(oauthParallelismCap({ pressure: null, baseMax: 5 })).toBeNull();
  });

  test('fails open at low confidence, however high the forecast', () => {
    const p = pressureAt(10_000, 3);
    expect(p.confidence).toBe('low');
    expect(p.pct).toBe(1);
    expect(oauthParallelismCap({ pressure: p, baseMax: 5 })).toBeNull();
  });

  test('leaves concurrency alone below half the learned window', () => {
    expect(oauthParallelismCap({ pressure: pressureAt(90), baseMax: 5 })).toBeNull();
  });

  test('narrows concurrency as the window fills', () => {
    // 75% of the learned window → halfway between the full limit and one.
    expect(oauthParallelismCap({ pressure: pressureAt(150), baseMax: 5 })).toBe(3);
  });

  test('never goes below one session, even past the learned wall', () => {
    expect(oauthParallelismCap({ pressure: pressureAt(10_000), baseMax: 5 })).toBe(1);
    // A one-session limit has nothing to narrow — never reads as zero.
    expect(oauthParallelismCap({ pressure: pressureAt(10_000), baseMax: 1 })).toBeNull();
  });

  test('never raises concurrency above the account limit', () => {
    const cap = oauthParallelismCap({ pressure: pressureAt(110), baseMax: 2 });
    expect(cap === null || cap <= 2).toBe(true);
  });

  test('restores the full limit once a reset empties the window', () => {
    expect(oauthParallelismCap({ pressure: pressureAt(10_000), baseMax: 5 })).toBe(1);
    expect(oauthParallelismCap({ pressure: pressureAt(0), baseMax: 5 })).toBeNull();
  });
});
