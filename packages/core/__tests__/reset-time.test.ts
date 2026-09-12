/**
 * Reset-time parsing: one parser, exact millisecond expectations.
 *
 * The bug this file exists to prevent: the runner carried its own hand-rolled
 * copy of these regexes, and its `(?:am|pm)?` group sat flush against the
 * digits — so a provider saying "try again at 10:58 pm" (with a space before
 * the meridiem) had its meridiem silently dropped, the minutes stripped, and
 * the bare hour "10" resolved to 10:00 the *following* morning. A reset that
 * had already gone by became a ~24h claim pause.
 *
 * Every case here asserts an exact duration with `toBe`. The tests that shipped
 * alongside the bug asserted only `toBeGreaterThan(0)`, which a wrong-by-a-day
 * answer satisfies just as well as a right one.
 */

import { describe, it, expect } from 'bun:test';
import {
  resetDelayMsFrom,
  clampPauseToQuotedReset,
  matchResetClause,
  extractResetTime,
  parseResetTime,
  PAUSE_FLOOR_MS,
  PAUSE_CEILING_MS,
  SESSION_WINDOW_MS,
} from '../reset-time';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** A fixed day, so "now" never depends on when CI runs. */
const at = (hhmm: string) => new Date(`2026-01-14T${hhmm}:00.000Z`);

describe('resetDelayMsFrom', () => {
  const cases: Array<{
    name: string;
    error: string;
    now: Date;
    expected: number | null;
  }> = [
    {
      name: 'spaced meridiem, still ahead — the incident wording',
      error: "you've hit your usage limit. try again at 10:58 pm.",
      now: at('22:00'),
      expected: 58 * MIN,
    },
    {
      name: 'spaced meridiem, already gone by — floor, not tomorrow',
      error: "you've hit your usage limit. try again at 10:58 PM.",
      now: at('23:10'),
      expected: PAUSE_FLOOR_MS,
    },
    {
      name: 'minutes are honoured, not stripped',
      error: 'try again at 3:45 PM',
      now: at('12:00'),
      expected: 3 * HOUR + 45 * MIN,
    },
    {
      name: 'unspaced meridiem must not regress',
      error: "you've hit your session limit · resets 8:20pm (UTC)",
      now: at('12:00'),
      expected: 8 * HOUR + 20 * MIN,
    },
    {
      name: 'spaced meridiem on the "resets" wording',
      error: "you've hit your session limit · resets 8:20 pm (UTC)",
      now: at('12:00'),
      expected: 8 * HOUR + 20 * MIN,
    },
    {
      // The general shape of the incident, on the "resets" wording: the pause
      // must shrink to the floor, not roll the clock time forward a day.
      name: 'unspaced meridiem, reported just after the reset went by',
      error: "you've hit your session limit · resets 8:20pm (UTC)",
      now: at('20:25'),
      expected: PAUSE_FLOOR_MS,
    },
    {
      name: 'spaced meridiem, reported just after the reset went by',
      error: "you've hit your session limit · resets 8:20 pm (UTC)",
      now: at('20:25'),
      expected: PAUSE_FLOOR_MS,
    },
    {
      // Minute-stripping bug, isolated: dropping ":20" moves the reset from
      // 20:20 to 20:00, which at 20:05 is already past — so the old code rolled
      // it forward a whole day. The minutes are what keep it 15 min away.
      name: 'the minutes decide whether the reset has passed at all',
      error: "you've hit your session limit · resets 8:20pm (UTC)",
      now: at('20:05'),
      expected: 15 * MIN,
    },
    {
      name: 'minutes with an am meridiem and a timezone',
      error: "you're out of extra usage · resets 11:20am (UTC)",
      now: at('09:00'),
      expected: 2 * HOUR + 20 * MIN,
    },
    {
      name: 'extra-usage wording, reported just after the reset went by',
      error: "you're out of extra usage · resets 11:20am (UTC)",
      now: at('11:25'),
      expected: PAUSE_FLOOR_MS,
    },
    {
      name: 'a timezone we will not guess at yields null, never a UTC hour',
      error: "you're out of extra usage · resets 3am (PST)",
      now: at('12:00'),
      expected: null,
    },
    {
      name: 'no reset clause at all is null, distinguishable from a real 1h reset',
      error: 'garbage',
      now: at('12:00'),
      expected: null,
    },
  ];

  for (const { name, error, now, expected } of cases) {
    it(name, () => {
      expect(resetDelayMsFrom(error, { now })).toBe(expected);
    });
  }

  it('null is reserved for "unparseable" — a genuine 1h reset returns 1h', () => {
    // The predecessor returned a silent 1h for both, so a caller could not tell
    // "the provider said one hour" from "I could not read the provider".
    expect(resetDelayMsFrom('try again at 1pm', { now: at('12:00') })).toBe(HOUR);
    expect(resetDelayMsFrom('try again at half past one', { now: at('12:00') })).toBeNull();
  });

  it('clamps to the floor and the ceiling', () => {
    // 11pm seen at 11:00pm sharp: the next occurrence is a day out, so the
    // nearest reading is the one that just happened -> floor.
    expect(resetDelayMsFrom('resets 11pm (UTC)', { now: at('23:00') })).toBe(PAUSE_FLOOR_MS);
    expect(resetDelayMsFrom('resets 8:20pm (UTC)', { now: at('12:00'), ceilingMs: 60 * MIN }))
      .toBe(60 * MIN);
    expect(resetDelayMsFrom('try again at 10:58 pm', { now: at('22:57'), floorMs: 10 * MIN }))
      .toBe(10 * MIN);
  });

  it('reads the nearest occurrence of the stated clock time, not the next one', () => {
    // 2pm at 1pm is an hour away; 2pm at 3pm was an hour ago (floor), not 23h out.
    expect(resetDelayMsFrom('try again at 2pm', { now: at('13:00') })).toBe(HOUR);
    expect(resetDelayMsFrom('try again at 2pm', { now: at('15:00') })).toBe(PAUSE_FLOOR_MS);
  });

  it('is null for empty and non-string input', () => {
    expect(resetDelayMsFrom('', { now: at('12:00') })).toBeNull();
    expect(resetDelayMsFrom(null, { now: at('12:00') })).toBeNull();
    expect(resetDelayMsFrom(undefined, { now: at('12:00') })).toBeNull();
  });
});

describe('clampPauseToQuotedReset', () => {
  it('leaves a pause that lands before the quoted reset alone', () => {
    const res = clampPauseToQuotedReset('try again at 10:58 pm', 30 * MIN, { now: at('22:00') });
    expect(res.pauseMs).toBe(30 * MIN);
    expect(res.clampedFromMs).toBeNull();
  });

  it('cuts a pause that would outlast the quoted reset', () => {
    // A branch default of 5h against a reset the provider put 58 min out.
    const res = clampPauseToQuotedReset('try again at 10:58 pm', 5 * HOUR, { now: at('22:00') });
    expect(res.pauseMs).toBe(58 * MIN);
    expect(res.clampedFromMs).toBe(5 * HOUR);
  });

  it('cuts to the floor when the quoted reset already passed', () => {
    const res = clampPauseToQuotedReset('try again at 10:58 pm', 5 * HOUR, { now: at('23:10') });
    expect(res.pauseMs).toBe(PAUSE_FLOOR_MS);
    expect(res.clampedFromMs).toBe(5 * HOUR);
  });

  it('cannot clamp what the text did not quote', () => {
    const res = clampPauseToQuotedReset('hit your session limit', 5 * HOUR, { now: at('12:00') });
    expect(res.pauseMs).toBe(5 * HOUR);
    expect(res.clampedFromMs).toBeNull();
  });
});

describe('matchResetClause', () => {
  it('captures the time and timezone of both wordings', () => {
    expect(matchResetClause('· resets 8:20 pm (UTC)')).toEqual({ time: '8:20 pm', timezone: 'UTC' });
    expect(matchResetClause('or try again at 10:58 pm.')).toEqual({ time: '10:58 pm', timezone: null });
    expect(matchResetClause('resets 3am (PST)')).toEqual({ time: '3am', timezone: 'PST' });
  });

  it('is null when no reset clause is present', () => {
    expect(matchResetClause('hit your usage limit')).toBeNull();
    expect(matchResetClause('resets soon')).toBeNull();
  });
});

describe('module boundary', () => {
  it('re-exports the pieces the web app imports, unchanged', () => {
    expect(SESSION_WINDOW_MS).toBe(5 * HOUR);
    expect(PAUSE_FLOOR_MS).toBe(5 * MIN);
    expect(PAUSE_CEILING_MS).toBe(24 * HOUR);
    expect(typeof parseResetTime).toBe('function');
    // extractResetTime keeps its session-window semantics: a reset further out
    // than one seat-session window is read as the occurrence that already went
    // by, which is what makes the web route write an elapsed budgetResetsAt.
    const now = at('12:00');
    expect(extractResetTime('resets 8:20pm (UTC)', { now })?.toISOString())
      .toBe('2026-01-13T20:20:00.000Z');
  });
});
