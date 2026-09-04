import { describe, it, expect } from 'bun:test';
import {
  prFreshnessTier,
  prStateSlaMs,
  isPrStateFresh,
  shouldMarkUnresolvable,
  describeAge,
  resolveStaleGate,
  TIER_SLA_MS,
  UNRESOLVABLE_FAILURE_THRESHOLD,
  HOUR_MS,
  DAY_MS,
  MINUTE_MS,
} from './pr-freshness';

const NOW = new Date('2026-09-03T22:51:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('prFreshnessTier', () => {
  it('classifies a PR opened minutes ago as hot', () => {
    expect(prFreshnessTier(10 * MINUTE_MS)).toBe('hot');
  });

  it('classifies a two-day-old PR as warm', () => {
    expect(prFreshnessTier(2 * DAY_MS)).toBe('warm');
  });

  it('classifies a 90-day-old PR as cold', () => {
    expect(prFreshnessTier(90 * DAY_MS)).toBe('cold');
  });

  it('puts the tier boundaries on the younger side', () => {
    expect(prFreshnessTier(DAY_MS - 1)).toBe('hot');
    expect(prFreshnessTier(DAY_MS)).toBe('warm');
    expect(prFreshnessTier(7 * DAY_MS - 1)).toBe('warm');
    expect(prFreshnessTier(7 * DAY_MS)).toBe('cold');
  });

  it('gives a cold PR a daily SLA, not the hot 30-minute one', () => {
    expect(prStateSlaMs(90 * DAY_MS)).toBe(TIER_SLA_MS.cold);
    expect(prStateSlaMs(10 * MINUTE_MS)).toBe(TIER_SLA_MS.hot);
  });
});

describe('isPrStateFresh', () => {
  it('is false when the row has never been checked', () => {
    expect(isPrStateFresh({ prOpenedAt: ago(HOUR_MS), checkedAt: null, now: NOW })).toBe(false);
  });

  it('is true for a hot PR checked within 30 minutes', () => {
    expect(isPrStateFresh({
      prOpenedAt: ago(2 * HOUR_MS),
      checkedAt: ago(10 * MINUTE_MS),
      now: NOW,
    })).toBe(true);
  });

  it('is false for a hot PR checked 45 minutes ago', () => {
    expect(isPrStateFresh({
      prOpenedAt: ago(2 * HOUR_MS),
      checkedAt: ago(45 * MINUTE_MS),
      now: NOW,
    })).toBe(false);
  });

  it('is true for a 90-day-old PR checked 6 hours ago — cold rows get a daily window', () => {
    expect(isPrStateFresh({
      prOpenedAt: ago(90 * DAY_MS),
      checkedAt: ago(6 * HOUR_MS),
      now: NOW,
    })).toBe(true);
  });

  it('is false for a 90-day-old PR checked 30 hours ago', () => {
    expect(isPrStateFresh({
      prOpenedAt: ago(90 * DAY_MS),
      checkedAt: ago(30 * HOUR_MS),
      now: NOW,
    })).toBe(false);
  });

  it('treats an unknown PR age as cold rather than assuming it is hot', () => {
    expect(isPrStateFresh({ prOpenedAt: null, checkedAt: ago(6 * HOUR_MS), now: NOW })).toBe(true);
    expect(isPrStateFresh({ prOpenedAt: null, checkedAt: ago(30 * HOUR_MS), now: NOW })).toBe(false);
  });
});

describe('shouldMarkUnresolvable', () => {
  it('does not condemn a row below the failure threshold', () => {
    expect(shouldMarkUnresolvable({
      failureCount: UNRESOLVABLE_FAILURE_THRESHOLD - 1,
      prOpenedAt: ago(90 * DAY_MS),
      now: NOW,
    })).toBe(false);
  });

  it('does not condemn a young PR even after repeated failures — a GitHub blip is not terminal', () => {
    expect(shouldMarkUnresolvable({
      failureCount: 10,
      prOpenedAt: ago(2 * HOUR_MS),
      now: NOW,
    })).toBe(false);
  });

  it('condemns a day-old row that has failed the threshold number of times', () => {
    expect(shouldMarkUnresolvable({
      failureCount: UNRESOLVABLE_FAILURE_THRESHOLD,
      prOpenedAt: ago(DAY_MS + HOUR_MS),
      now: NOW,
    })).toBe(true);
  });

  it('condemns a row with no known PR age once it has failed the threshold', () => {
    expect(shouldMarkUnresolvable({
      failureCount: UNRESOLVABLE_FAILURE_THRESHOLD,
      prOpenedAt: null,
      now: NOW,
    })).toBe(true);
  });
});

describe('describeAge', () => {
  it('renders sub-48h ages in hours and longer ones in days', () => {
    expect(describeAge(36 * HOUR_MS)).toBe('36 hours');
    expect(describeAge(HOUR_MS)).toBe('1 hour');
    expect(describeAge(90 * DAY_MS)).toBe('90 days');
  });
});

describe('resolveStaleGate', () => {
  it('opts out entirely when the caller supplies no PR age', () => {
    expect(resolveStaleGate({ now: NOW })).toBeNull();
  });

  it('passes a fresh, recent PR', () => {
    expect(resolveStaleGate({
      prOpenedAt: ago(3 * HOUR_MS),
      prLifecycleCheckedAt: ago(5 * MINUTE_MS),
      now: NOW,
    })).toBeNull();
  });

  it('flags a never-verified row as unverified, not open', () => {
    const gate = resolveStaleGate({
      prOpenedAt: ago(3 * HOUR_MS),
      prLifecycleCheckedAt: null,
      now: NOW,
    });
    expect(gate?.kind).toBe('unverified');
    expect(gate?.reason).toContain('never been verified');
  });

  it('flags a row verified outside its tier SLA and states how long ago', () => {
    const gate = resolveStaleGate({
      prOpenedAt: ago(90 * DAY_MS),
      prLifecycleCheckedAt: ago(4 * DAY_MS),
      now: NOW,
    });
    expect(gate?.kind).toBe('unverified');
    expect(gate?.reason).toContain('4 days ago');
    expect(gate?.ageHours).toBe(90 * 24);
  });

  it('flags a freshly-verified but ancient open PR as a decision, not a merge', () => {
    const gate = resolveStaleGate({
      prOpenedAt: ago(90 * DAY_MS),
      prLifecycleCheckedAt: ago(HOUR_MS),
      now: NOW,
    });
    expect(gate?.kind).toBe('ancient');
    expect(gate?.reason).toContain('90 days');
  });

  it('does not flag a 13-day-old PR that is being checked on schedule', () => {
    expect(resolveStaleGate({
      prOpenedAt: ago(13 * DAY_MS),
      prLifecycleCheckedAt: ago(2 * HOUR_MS),
      now: NOW,
    })).toBeNull();
  });

  it('prefers unverified over ancient — not knowing outranks knowing it is old', () => {
    const gate = resolveStaleGate({
      prOpenedAt: ago(90 * DAY_MS),
      prLifecycleCheckedAt: null,
      now: NOW,
    });
    expect(gate?.kind).toBe('unverified');
  });
});
