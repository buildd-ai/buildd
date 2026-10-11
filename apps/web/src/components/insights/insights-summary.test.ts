import { describe, it, expect } from 'bun:test';
import type { FlowSeries } from '@/lib/insights-flow';
import { TIME_CATEGORIES, type TimeCategory } from '@/lib/insights-time-split';
import { dayBars, formatTimeShare, parseSplitFilter, shippingSentence, stallSentences, tasksWithTime, timeRows, timeTaskListHref } from './insights-summary';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2026, 9, 4, 12);

function series(over: { shipped?: number; prev?: number | null; median?: number | null; time?: Partial<Record<TimeCategory, [ms: number, tasks: number, longest?: number]>> } = {}): FlowSeries {
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
      const [ms, tasks, longestMs] = over.time?.[category] ?? [0, 0];
      return { category, ms, tasks, longestMs: longestMs ?? ms };
    }),
    previous: over.prev === null ? null : { shippedTasks: over.prev ?? 0, lostTasks: 0, days: Array.from({ length: 7 }, (_, i) => ({ start: T0 - 7 * D + i * D, end: T0 - 6 * D + i * D, shipped: 1, lost: 0 })) },
  };
}

describe('shippingSentence', () => {
  it('leads with the count, the change on last week, and the median to production', () => {
    expect(shippingSentence(series({ shipped: 12, prev: 10, median: 5 * H }), '7d'))
      .toBe('Shipped 12 tasks this week, up 20% on last week; median 5.0h from start to production.');
    expect(shippingSentence(series({ shipped: 8, prev: 10, median: 30 * H }), '7d'))
      .toBe('Shipped 8 tasks this week, down 20% on last week; median 30h from start to production.');
  });

  it('says the same, none, or nothing to compare plainly', () => {
    expect(shippingSentence(series({ shipped: 3, prev: 3 }), '7d')).toBe('Shipped 3 tasks this week, the same as last week.');
    expect(shippingSentence(series({ shipped: 1, prev: 0 }), '7d')).toBe('Shipped 1 task this week, none last week.');
    expect(shippingSentence(series({ shipped: 4, prev: null }), '7d')).toBe('Shipped 4 tasks this week.');
    expect(shippingSentence(series({ shipped: 0, prev: 5 }), '7d')).toBe('No tasks shipped this week, 5 tasks last week.');
    expect(shippingSentence(series({ shipped: 0, prev: 0 }), '7d')).toBe('No tasks shipped this week.');
  });

  it('names the 30-day window', () => {
    expect(shippingSentence(series({ shipped: 40, prev: 20 }), '30d')).toBe('Shipped 40 tasks in the last 30 days, up 100% on the 30 days before.');
  });

  it('never uses an em dash', () => {
    for (const s of [series({ shipped: 2, prev: 1, median: H }), series({})]) expect(shippingSentence(s, '7d')).not.toContain('—');
  });
});

describe('timeRows', () => {
  it('one row per category in display order, shares summing to 1, each linking to its tasks', () => {
    const rows = timeRows(series({ time: { needs_input: [2 * H, 1], review: [6 * H, 3], running: [8 * H, 5], release: [4 * H, 2] } }));
    expect(rows.map(r => r.label)).toEqual(['Needs input', 'Waiting for CI', 'In review', 'Waiting for a runner', 'Running', 'Retries after failure', 'Waiting for a release']);
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
  it('the three biggest waits, largest first, in plain words; running is not a stall', () => {
    const out = stallSentences(series({ time: {
      running: [50 * H, 9], review: [20 * H, 4, 9 * H], runner: [6 * H, 3, 3 * H], needs_input: [12 * H, 1], ci: [2 * H, 2],
    } }));
    expect(out).toEqual([
      '4 PRs sat in review for 20h; the longest was 9.0h.',
      '1 task needed input for 12h in all.',
      '3 tasks waited 6.0h for a runner to pick them up; the longest was 3.0h.',
    ]);
  });

  it('is empty when nothing waited', () => {
    expect(stallSentences(series({ time: { running: [H, 1] } }))).toEqual([]);
  });

  it('never names an internal status', () => {
    const all = stallSentences(series({ time: { needs_input: [H, 2], ci: [H, 2], review: [H, 2] } })).join(' ');
    expect(all).not.toMatch(/waiting_input|ci_running|needs_input|—/);
  });
});

describe('dayBars', () => {
  it('pairs each day with the same day of the window before', () => {
    const bars = dayBars(series({ prev: 7 }), '7d');
    expect(bars).toHaveLength(7);
    expect(bars[3]).toMatchObject({ shipped: 3, lost: 1, prevShipped: 1, prevLost: 0 });
  });

  it('has no reference when the window before was not read', () => {
    expect(dayBars(series({ prev: null }), '7d').every(b => b.prevShipped === null)).toBe(true);
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
