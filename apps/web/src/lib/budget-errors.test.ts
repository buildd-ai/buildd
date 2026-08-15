import { describe, it, expect } from 'bun:test';
import {
  isBudgetExhaustionError,
  parseResetTime,
  extractResetTime,
  SESSION_WINDOW_MS,
} from './budget-errors';

describe('isBudgetExhaustionError', () => {
  it('detects API-key dollar-budget exhaustion', () => {
    expect(isBudgetExhaustionError('Budget limit exceeded (maxBudgetUsd)')).toBe(true);
    expect(isBudgetExhaustionError('error_max_budget_usd')).toBe(true);
    expect(isBudgetExhaustionError('You are out of extra usage')).toBe(true);
    expect(isBudgetExhaustionError('hit max budget')).toBe(true);
  });

  // Regression: the OAuth seat session cap that stalled a mission mid-run.
  // Previously unmatched, so the account budget was never flagged and the claim
  // route kept handing out Claude tasks that died with "Not logged in".
  it('detects OAuth session-limit exhaustion', () => {
    expect(
      isBudgetExhaustionError(
        "Claude Code returned an error result: You've hit your session limit · resets 3am (UTC)",
      ),
    ).toBe(true);
    expect(isBudgetExhaustionError('session limit reached')).toBe(true);
  });

  it('does not flag unrelated failures', () => {
    expect(isBudgetExhaustionError('Not logged in · Please run /login')).toBe(false);
    expect(isBudgetExhaustionError('git fatal: not a repository')).toBe(false);
    expect(isBudgetExhaustionError('')).toBe(false);
    expect(isBudgetExhaustionError(undefined)).toBe(false);
    expect(isBudgetExhaustionError(null)).toBe(false);
  });
});

describe('parseResetTime', () => {
  it('parses 12-hour reset times into a future UTC Date', () => {
    const reset = parseResetTime('3am');
    expect(reset).toBeInstanceOf(Date);
    expect(reset!.getUTCHours()).toBe(3);
    expect(reset!.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for unparseable input', () => {
    expect(parseResetTime('later')).toBeNull();
  });

  // Regression (2026-08-15): Claude reports "resets 11:10am (UTC)" — with
  // minutes. The old `^(\d{1,2})(am|pm)?$` pattern rejected it, so the caller
  // fell back to `now + 5h` and froze claims for 5h against a real 2h46m wait.
  it('parses minutes, not just whole hours', () => {
    const now = new Date('2026-08-15T08:24:30Z');
    const reset = parseResetTime('11:10am', { now });
    expect(reset?.toISOString()).toBe('2026-08-15T11:10:00.000Z');
  });

  it('applies the meridiem to hour and preserves minutes', () => {
    const now = new Date('2026-08-15T08:00:00Z');
    expect(parseResetTime('11:10pm', { now })?.toISOString()).toBe('2026-08-15T23:10:00.000Z');
    expect(parseResetTime('12:05pm', { now })?.toISOString()).toBe('2026-08-15T12:05:00.000Z');
  });

  it('treats 12am as midnight', () => {
    const now = new Date('2026-08-15T22:00:00Z');
    // 12:30am has already passed on the 15th, so it means the 16th.
    expect(parseResetTime('12:30am', { now })?.toISOString()).toBe('2026-08-16T00:30:00.000Z');
  });

  it('parses 24-hour times with no meridiem', () => {
    const now = new Date('2026-08-15T20:00:00Z');
    expect(parseResetTime('23:45', { now })?.toISOString()).toBe('2026-08-15T23:45:00.000Z');
  });

  it('parses a bare hour as :00', () => {
    const now = new Date('2026-08-15T08:00:00Z');
    expect(parseResetTime('9', { now })?.toISOString()).toBe('2026-08-15T09:00:00.000Z');
  });

  it('rolls over to the next day when the time already passed', () => {
    const now = new Date('2026-08-15T23:50:00Z');
    expect(parseResetTime('1am', { now })?.toISOString()).toBe('2026-08-16T01:00:00.000Z');
  });

  it('tolerates surrounding whitespace and mixed case', () => {
    const now = new Date('2026-08-15T08:00:00Z');
    expect(parseResetTime('  11:10AM  ', { now })?.toISOString()).toBe('2026-08-15T11:10:00.000Z');
  });

  it('rejects out-of-range hours and minutes rather than silently rolling over', () => {
    const now = new Date('2026-08-15T08:00:00Z');
    // Date.UTC would happily turn hour 25 into the next day at 01:00.
    expect(parseResetTime('25', { now })).toBeNull();
    expect(parseResetTime('99', { now })).toBeNull();
    expect(parseResetTime('11:60am', { now })).toBeNull();
    expect(parseResetTime('11:99', { now })).toBeNull();
    // 13pm is not a valid 12-hour clock reading.
    expect(parseResetTime('13pm', { now })).toBeNull();
  });

  it('returns null for empty or junk input', () => {
    expect(parseResetTime('')).toBeNull();
    expect(parseResetTime('   ')).toBeNull();
    expect(parseResetTime('half past four')).toBeNull();
  });

  it('honours an explicit UTC timezone', () => {
    const now = new Date('2026-08-15T08:00:00Z');
    expect(parseResetTime('11:10am', { now, timezone: 'UTC' })?.toISOString())
      .toBe('2026-08-15T11:10:00.000Z');
    expect(parseResetTime('11:10am', { now, timezone: 'utc' })?.toISOString())
      .toBe('2026-08-15T11:10:00.000Z');
  });

  // The old extraction regex captured the timezone into group 2 and then never
  // passed it anywhere, so a non-UTC reset would have been silently read as UTC.
  // Refusing to guess is the safe move: the caller falls back to now + 5h.
  it('refuses to guess when the timezone is not UTC', () => {
    const now = new Date('2026-08-15T08:00:00Z');
    expect(parseResetTime('11:10am', { now, timezone: 'PST' })).toBeNull();
    expect(parseResetTime('11:10am', { now, timezone: 'America/New_York' })).toBeNull();
  });
});

describe('extractResetTime', () => {
  // The exact string Claude emitted during the 2026-08-15 incident.
  it('extracts the reset time from a real session-limit error', () => {
    const now = new Date('2026-08-15T08:24:30Z');
    const error =
      "Claude Code returned an error result: You've hit your session limit · resets 11:10am (UTC)";
    const reset = extractResetTime(error, { now });
    expect(reset?.toISOString()).toBe('2026-08-15T11:10:00.000Z');
    // The whole point: a 2h46m freeze, not the blanket 5h fallback.
    expect(reset!.getTime() - now.getTime()).toBeLessThan(SESSION_WINDOW_MS);
  });

  it('still handles the whole-hour form', () => {
    const now = new Date('2026-08-15T00:30:00Z');
    const error = "You've hit your session limit · resets 3am (UTC)";
    expect(extractResetTime(error, { now })?.toISOString()).toBe('2026-08-15T03:00:00.000Z');
  });

  it('handles a 24-hour reset time', () => {
    const now = new Date('2026-08-15T20:00:00Z');
    expect(
      extractResetTime("session limit · resets 23:45 (UTC)", { now })?.toISOString(),
    ).toBe('2026-08-15T23:45:00.000Z');
  });

  it('returns null when there is no reset clause to read', () => {
    const now = new Date('2026-08-15T08:00:00Z');
    expect(extractResetTime("You've hit your session limit", { now })).toBeNull();
    expect(extractResetTime('Not logged in', { now })).toBeNull();
  });

  // Claude always states "(UTC)". If it ever omits the zone we assume UTC,
  // which biases toward unfreezing early — a worker then retries, hits the cap
  // again and re-freezes. Erring long instead would burn hours of capacity.
  it('assumes UTC when no timezone is stated', () => {
    const now = new Date('2026-08-15T08:00:00Z');
    expect(extractResetTime('session limit · resets 11:10am', { now })?.toISOString())
      .toBe('2026-08-15T11:10:00.000Z');
  });

  it('returns null for non-UTC zones instead of assuming UTC', () => {
    const now = new Date('2026-08-15T08:00:00Z');
    expect(extractResetTime('session limit · resets 11:10am (PST)', { now })).toBeNull();
  });

  it('returns null for missing or non-string input', () => {
    expect(extractResetTime(null)).toBeNull();
    expect(extractResetTime(undefined)).toBeNull();
    expect(extractResetTime('')).toBeNull();
  });

  // A session window is 5h and the error is raised during it, so a next-
  // occurrence more than 5h out means the stated time already went by and the
  // rollover overshot. The reset has therefore already happened, and the honest
  // answer is that past time — not "tomorrow", which froze claims for ~19h.
  it('steps back a day when the rollover overshoots the session window', () => {
    const now = new Date('2026-08-15T08:24:30Z');
    // Naive rollover gives 2026-08-16T03:00Z (~18.6h out); 3am today is correct.
    const reset = extractResetTime('session limit · resets 3am (UTC)', { now });
    expect(reset?.toISOString()).toBe('2026-08-15T03:00:00.000Z');
    // Already elapsed, so the caller serves no freeze at all.
    expect(reset!.getTime()).toBeLessThan(now.getTime());
  });

  // Guards the exact shape of the route.test.ts regression from #1678, which
  // runs against the real clock: "11:10am" must report 11:10 whatever the hour.
  it('reports the stated clock time regardless of when it is evaluated', () => {
    const error = "You've hit your session limit · resets 11:10am (UTC)";
    for (const iso of [
      '2026-08-15T08:24:30Z', // before — reset is ahead, same day
      '2026-08-15T13:40:00Z', // after  — reset already passed
      '2026-08-15T23:59:00Z', // late   — still the same stated clock time
      '2026-08-15T00:05:00Z', // early
    ]) {
      const reset = extractResetTime(error, { now: new Date(iso) });
      expect(reset).not.toBeNull();
      expect(reset!.getUTCHours()).toBe(11);
      expect(reset!.getUTCMinutes()).toBe(10);
    }
  });

  it('accepts a reset exactly at the session-window boundary', () => {
    const now = new Date('2026-08-15T08:00:00Z');
    // now + 5h == 13:00Z exactly.
    expect(extractResetTime('session limit · resets 13:00 (UTC)', { now })?.toISOString())
      .toBe('2026-08-15T13:00:00.000Z');
  });
});
