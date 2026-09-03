import { describe, it, expect } from 'bun:test';
import {
  coverageLabel,
  depletionProjection,
  failureStreak,
  freshness,
  groupFailuresBySignature,
  lifetimeRuns,
  monthlyAnchor,
  observedAgo,
  sectionDenominator,
} from './health-metric-grammar';

const NOW = new Date('2026-09-03T12:00:00.000Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('freshness (STATE)', () => {
  it('reads from the stat\'s own timestamp, in hours and days', () => {
    expect(freshness(ago(3 * HOUR), NOW)).toBe('as of 3h ago');
    expect(freshness(ago(2 * DAY), NOW)).toBe('as of 2d ago');
    expect(freshness(ago(20 * MINUTE), NOW)).toBe('as of 20m ago');
    expect(freshness(ago(10 * 1000), NOW)).toBe('as of just now');
  });

  it('never fabricates freshness for a stat that was never observed', () => {
    expect(freshness(null, NOW)).toBe('never observed');
    expect(freshness(undefined, NOW)).toBe('never observed');
    expect(freshness('not-a-date', NOW)).toBe('never observed');
    expect(observedAgo(null, NOW)).toBeNull();
  });

  it('reads a clock-skewed future timestamp as just now, not as a negative age', () => {
    expect(freshness(new Date(NOW + HOUR).toISOString(), NOW)).toBe('as of just now');
  });

  it('truncates rather than rounds, so a stat never claims to be fresher than it is', () => {
    expect(freshness(ago(3 * HOUR + 59 * MINUTE), NOW)).toBe('as of 3h ago');
    expect(freshness(ago(2 * DAY - 1), NOW)).toBe('as of 1d ago');
  });
});

describe('coverageLabel (TREND)', () => {
  it('renders an exact ratio when every counted row was measured exactly', () => {
    expect(coverageLabel({ covered: 67, population: 163 })).toBe('67/163');
    expect(coverageLabel({ covered: 67, population: 163, hasDerived: false })).toBe('67/163');
  });

  it('marks the numerator as a floor when any row was reconstructed', () => {
    expect(coverageLabel({ covered: 67, population: 163, hasDerived: true })).toBe('≥67/163');
  });
});

describe('sectionDenominator', () => {
  it('names the population, because the four sections do not share one', () => {
    expect(sectionDenominator(341, 'terminal worker sessions')).toBe('over 341 terminal worker sessions');
    expect(sectionDenominator(12, 'runners')).toBe('over 12 runners');
  });
});

describe('LIFETIME grammar', () => {
  it('anchors schedule counters to creation, not to a window', () => {
    expect(lifetimeRuns(412)).toBe('412 runs since created');
    expect(lifetimeRuns(1)).toBe('1 run since created');
    expect(lifetimeRuns(0)).toBe('0 runs since created');
  });

  it('reads a streak as a streak', () => {
    expect(failureStreak(3)).toBe('3 in a row');
  });

  it('anchors a monthly budget to the calendar month it accumulates over', () => {
    // The reset instant is the start of the NEXT period.
    expect(monthlyAnchor('2026-10-01T00:00:00.000Z')).toBe('since Sep 1');
    expect(monthlyAnchor('2026-01-01T00:00:00.000Z')).toBe('since Dec 1');
  });

  it('falls back to a vague-but-true anchor rather than an invented date', () => {
    expect(monthlyAnchor('nonsense')).toBe('this month');
  });
});

describe('depletionProjection (PROJECTION)', () => {
  it('states the value and the window the rate came from in one string', () => {
    expect(depletionProjection(4.25, '24h')).toBe('depletes in 4.3d · from 24h burn');
  });

  it('drops to hours under a day', () => {
    expect(depletionProjection(0.5, '24h')).toBe('depletes in 12h · from 24h burn');
  });

  it('renders nothing when there is no projection to make', () => {
    expect(depletionProjection(null, '24h')).toBeNull();
  });
});

describe('groupFailuresBySignature (Problems)', () => {
  const fail = (error: string | null, at: string) => ({ error, completedAt: at, id: error });

  it('clusters on the same key the failure signature table uses', () => {
    const rows = [
      fail('Deferred: another Codex worker (a1b2c3d4) is already active', ago(HOUR)),
      fail('Deferred: another Codex worker (99887766) is already active', ago(2 * HOUR)),
      fail('Stale worker expired (no update for 15+ minutes)', ago(3 * HOUR)),
    ];
    const grouped = groupFailuresBySignature(rows);
    expect(grouped.groups).toHaveLength(2);
    expect(grouped.groups[0].count).toBe(2);
    expect(grouped.groups[0].signature).toBe(
      'Deferred: another Codex worker (<id>) is already active',
    );
    expect(grouped.total).toBe(3);
  });

  it('keeps the most recent member as the sample, whatever the input order', () => {
    const older = fail('boom', ago(5 * HOUR));
    const newer = fail('boom', ago(HOUR));
    expect(groupFailuresBySignature([older, newer]).groups[0].sample).toBe(newer);
    expect(groupFailuresBySignature([newer, older]).groups[0].sample).toBe(newer);
    expect(groupFailuresBySignature([newer, older]).groups[0].lastSeen).toBe(newer.completedAt);
  });

  it('caps the group list and counts the remainder in FAILURES, not clusters', () => {
    // Letters, not digits: the signature normalizer collapses every number to
    // `<n>`, so `kind 1` / `kind 2` would be ONE cluster, not two.
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => fail('top failure', ago((i + 1) * MINUTE))),
      ...Array.from({ length: 6 }, (_, i) => fail(`distinct kind ${'abcdef'[i]}`, ago(HOUR))),
      fail('distinct kind a', ago(2 * HOUR)),
    ];
    const grouped = groupFailuresBySignature(rows, 5);
    expect(grouped.groups).toHaveLength(5);
    expect(grouped.hiddenGroups).toBe(2);
    expect(grouped.hiddenFailures).toBe(2);
    expect(grouped.total).toBe(11);
  });

  it('groups failures that carry no error text at all rather than dropping them', () => {
    const grouped = groupFailuresBySignature([fail(null, ago(HOUR)), fail(null, ago(2 * HOUR))]);
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups[0].signature).toBe('(no error message)');
    expect(grouped.groups[0].count).toBe(2);
  });

  it('returns an empty, zeroed result for no failures', () => {
    const grouped = groupFailuresBySignature([]);
    expect(grouped.groups).toEqual([]);
    expect(grouped.hiddenGroups).toBe(0);
    expect(grouped.hiddenFailures).toBe(0);
    expect(grouped.total).toBe(0);
  });
});
