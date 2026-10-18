import { describe, it, expect } from 'bun:test';
import type { FlowSeries } from '@/lib/insights-flow';
import { TIME_CATEGORIES, type TimeCategory } from '@/lib/insights-time-split';
import { comparisonCaption, dayBars, formatTimeShare, parseSplitFilter, shippingSentence, stallSentences, tasksWithTime, timeRows, timeTaskListHref } from './insights-summary';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2026, 9, 4, 12);

function series(over: { shipped?: number; prev?: number | null; median?: number | null; time?: Partial<Record<TimeCategory, [ms: number, tasks: number, longest?: number, median?: number, p90?: number]>> } = {}): FlowSeries {
  return {
    window: { from: T0, to: T0 + 7 * D },
    bucketMs: H,
    buckets: [],
    releases: [],
    tasks: [],
    roles: [],
    headline: {
      shippedShare: null, shippedHours: 0, lostHours: 0, inFlightHours: 0, otherHours: 0,
      shippedTasks: over.shipped ?? 0, lostTasks: 0, releases: 0, medianStartToProdMs: over.median ?? null,
    },
    days: Array.from({ length: 7 }, (_, i) => ({ start: T0 + i * D, end: T0 + (i + 1) * D, shipped: i, lost: i % 2 })),
    time: TIME_CATEGORIES.map(category => {
      const [ms, tasks, longestMs, medianMs, p90Ms] = over.time?.[category] ?? [0, 0];
      return { category, ms, tasks, longestMs: longestMs ?? ms, medianMs: medianMs ?? (tasks ? ms / tasks : 0), p90Ms: p90Ms ?? longestMs ?? ms };
    }),
    previous: over.prev === null ? null : { window: { from: T0 - 7 * D, to: T0 }, shippedTasks: over.prev ?? 0, lostTasks: 0, days: Array.from({ length: 7 }, (_, i) => ({ start: T0 - 7 * D + i * D, end: T0 - 6 * D + i * D, shipped: 1, lost: 0 })) },
  };
}

describe('shippingSentence', () => {
  it('leads with the count, the change on the span before, and the median to production', () => {
    expect(shippingSentence(series({ shipped: 12, prev: 10, median: 5 * H }), '7d'))
      .toBe('12 tasks done in the last 7 days, up 20% on the 7 days before (10); median 5.0h from first agent start to production.');
    expect(shippingSentence(series({ shipped: 8, prev: 10, median: 30 * H }), '7d'))
      .toBe('8 tasks done in the last 7 days, down 20% on the 7 days before (10); median 30h from first agent start to production.');
  });

  it('says the same, none, or nothing to compare plainly', () => {
    expect(shippingSentence(series({ shipped: 3, prev: 3 }), '7d')).toBe('3 tasks done in the last 7 days, the same as the 7 days before.');
    expect(shippingSentence(series({ shipped: 1, prev: 0 }), '7d')).toBe('1 task done in the last 7 days, none the 7 days before.');
    expect(shippingSentence(series({ shipped: 4, prev: null }), '7d')).toBe('4 tasks done in the last 7 days.');
    expect(shippingSentence(series({ shipped: 0, prev: 5 }), '7d')).toBe('No tasks done in the last 7 days, 5 tasks the 7 days before.');
    expect(shippingSentence(series({ shipped: 0, prev: 0 }), '7d')).toBe('No tasks done in the last 7 days.');
  });

  it('does not say "up 0%" for a change that rounds away', () => {
    expect(shippingSentence(series({ shipped: 1001, prev: 1000 }), '7d')).toContain('about the same as the 7 days before (1000)');
  });

  it('names the 30-day window', () => {
    expect(shippingSentence(series({ shipped: 40, prev: 20 }), '30d')).toBe('40 tasks done in the last 30 days, up 100% on the 30 days before (20).');
  });

  it('never calls a rolling window a week or a month on the calendar', () => {
    expect(shippingSentence(series({ shipped: 2, prev: 1 }), '7d')).not.toMatch(/this week|last week/);
  });

  it('never uses an em dash', () => {
    for (const s of [series({ shipped: 2, prev: 1, median: H }), series({})]) expect(shippingSentence(s, '7d')).not.toContain('—');
  });
});

describe('comparisonCaption', () => {
  const o = { timeZone: 'UTC', locale: 'en-US' };
  it('names the exact current and previous spans and that the window rolls', () => {
    const c = comparisonCaption(series({ shipped: 1, prev: 1 }), '7d', o);
    expect(c).toContain('Rolling 7 days: Oct 4, 12:00 PM to Oct 11, 12:00 PM.');
    expect(c).toContain('Compared with Sep 27, 12:00 PM to Oct 4, 12:00 PM.');
    expect(c).toContain('do not follow calendar days');
    expect(c).toContain('same weekday a week earlier');
  });

  it('says 30 days compare in total, and drops the previous span when it was not read', () => {
    expect(comparisonCaption(series({ shipped: 1, prev: 1 }), '30d', o)).toContain('compared in total');
    const none = comparisonCaption(series({ prev: null }), '7d', o);
    expect(none).not.toContain('Compared with');
  });
});

describe('timeRows', () => {
  it('one row per category in display order, shares summing to 1, each linking to its tasks', () => {
    const rows = timeRows(series({ time: { needs_input: [2 * H, 1], review: [6 * H, 3], running: [8 * H, 5], release: [4 * H, 2] } }));
    expect(rows.map(r => r.label)).toEqual(['Has a question', 'Waiting for CI', 'In review', 'Waiting for a runner', 'Working', 'Retries after failure', 'Waiting for a release']);
    expect(rows.reduce((m, r) => m + r.share, 0)).toBeCloseTo(1);
    expect(rows.find(r => r.category === 'review')!.share).toBeCloseTo(0.3);
    expect(rows[0].href).toContain('split=needs_input');
  });

  it('hides the release row when nothing waited for one', () => {
    expect(timeRows(series({ time: { running: [H, 1] } })).some(r => r.category === 'release')).toBe(false);
  });

  it('reads as zero shares, not NaN, on an empty window', () => {
    expect(timeRows(series()).every(r => r.share === 0)).toBe(true);
  });
});

describe('stallSentences', () => {
  it('the three biggest waits as counts with median and p90, never a summed headline; running is not a stall', () => {
    const out = stallSentences(series({ time: {
      running: [50 * H, 9], review: [20 * H, 4, 9 * H, 4 * H, 9 * H], runner: [6 * H, 3, 3 * H, 2 * H, 3 * H], needs_input: [12 * H, 1], ci: [2 * H, 2],
    } }));
    expect(out).toEqual([
      '4 PRs sat in review: median 4.0h, 90th percentile 9.0h.',
      '1 task had a question waiting for 12h.',
      '3 tasks waited for a runner to pick them up: median 2.0h, 90th percentile 3.0h.',
    ]);
  });

  it('is empty when nothing waited', () => {
    expect(stallSentences(series({ time: { running: [H, 1] } }))).toEqual([]);
  });

  it('never names an internal status or says "in all"', () => {
    const all = stallSentences(series({ time: { needs_input: [H, 2], ci: [H, 2], review: [H, 2] } })).join(' ');
    expect(all).not.toMatch(/waiting_input|ci_running|needs_input|in all|—/);
  });
});

describe('dayBars', () => {
  const o = { timeZone: 'UTC', locale: 'en-US' };
  it('pairs each 7-day bar with the same weekday a week earlier', () => {
    const bars = dayBars(series({ prev: 7 }), '7d', o);
    expect(bars).toHaveLength(7);
    expect(bars[3]).toMatchObject({ shipped: 3, lost: 1, prevShipped: 1, prevLost: 0 });
    expect(bars[0].label).toBe('Sun');
    expect(bars[0].range).toBe('Sun, Oct 4, 12:00 PM to Mon, Oct 5, 12:00 PM');
  });

  it('does not pair 30-day bars: 30 days earlier is another weekday', () => {
    expect(dayBars(series({ prev: 7 }), '30d', o).every(b => b.prevShipped === null)).toBe(true);
  });

  it('has no reference when the window before was not read', () => {
    expect(dayBars(series({ prev: null }), '7d', o).every(b => b.prevShipped === null)).toBe(true);
  });

  it('marks a slice shorter than 24 hours as partial', () => {
    const s = series();
    s.days[6] = { ...s.days[6], end: s.days[6].start + 5 * H };
    const bars = dayBars(s, '7d', o);
    expect(bars.map(b => b.partial)).toEqual([false, false, false, false, false, false, true]);
  });

  it('keeps 24-hour slices across a DST change and shows the local span', () => {
    // US clocks went back on 2026-11-01: the slice starting Oct 31 12:00 New York lasts 24h, ending 11:00 local.
    const from = Date.UTC(2026, 9, 31, 16);
    const s = series();
    s.days = [{ start: from, end: from + D, shipped: 1, lost: 0 }];
    const [bar] = dayBars(s, '7d', { timeZone: 'America/New_York', locale: 'en-US' });
    expect(bar.partial).toBe(false);
    expect(bar.range).toBe('Sat, Oct 31, 12:00 PM to Sun, Nov 1, 11:00 AM');
  });

  it('names a bar by the local day it starts, around midnight', () => {
    const from = Date.UTC(2026, 9, 4, 23, 30); // 23:30 UTC Sunday = 00:30 Monday in Berlin (CEST)
    const s = series();
    s.days = [{ start: from, end: from + D, shipped: 0, lost: 0 }];
    expect(dayBars(s, '7d', { timeZone: 'UTC', locale: 'en-US' })[0].label).toBe('Sun');
    expect(dayBars(s, '7d', { timeZone: 'Europe/Berlin', locale: 'en-US' })[0].label).toBe('Mon');
  });
});

describe('the tasks behind a row', () => {
  it('round-trips the link and rejects anything else', () => {
    const s = series();
    const params = Object.fromEntries(new URLSearchParams(timeTaskListHref(s, 'ci').split('?')[1]));
    expect(parseSplitFilter(params)).toEqual({ category: 'ci', from: s.window.from, to: s.window.to });
    expect(parseSplitFilter({ ...params, split: 'bogus' })).toBeNull();
    expect(parseSplitFilter({ ...params, to: String(s.window.to + 1) })).toBeNull();
    expect(parseSplitFilter({})).toBeNull();
  });

  it('lists tasks that spent time in the category, most first', () => {
    const s = series();
    const task = (key: string, ci: number) => ({ key, title: key, missionId: null, workspaceId: 'w', role: 'builder', segments: [], shippedAt: null, lostAt: null, agentHours: 0, time: { needs_input: 0, ci, review: 0, runner: 0, running: 0, retry: 0, release: 0 } });
    s.tasks = [task('a', H), task('b', 0), task('c', 3 * H)];
    expect(tasksWithTime(s, 'ci').map(t => t.key)).toEqual(['c', 'a']);
  });
});

describe('formatTimeShare', () => {
  it('never shows 0% for time that was spent', () => {
    expect(formatTimeShare(0.001)).toBe('<1%');
    expect(formatTimeShare(0)).toBe('0%');
    expect(formatTimeShare(0.81)).toBe('81%');
  });
});
