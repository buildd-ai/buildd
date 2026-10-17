/**
 * Insights in words: the shipping sentence, where task time went, the top
 * stalls, and the per-day bars. Pure, so the copy is tested without a DOM.
 */
import type { FlowSeries, FlowWindow } from '@/lib/insights-flow';
import { TIME_CATEGORIES, type TimeCategory } from '@/lib/insights-time-split';
import { countOf } from '@/lib/plural';
import { formatDuration } from './flow-chart-model';

const HOUR = 3_600_000;
const WINDOW_MS: Record<FlowWindow, number> = { '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR };

export const TIME_LABEL: Record<TimeCategory, string> = {
  needs_input: 'Has a question',
  ci: 'Waiting for CI',
  review: 'In review',
  runner: 'Waiting for a runner',
  running: 'Running',
  retry: 'Retries after failure',
  release: 'Waiting for a release',
};

const DAY = 24 * HOUR;

/** Windows are rolling: the last N x 24 hours up to now, never a calendar week or month. */
const PERIOD: Record<FlowWindow, { now: string; before: string }> = {
  '7d': { now: 'in the last 7 days', before: 'the 7 days before' },
  '30d': { now: 'in the last 30 days', before: 'the 30 days before' },
};

export interface FormatOptions { timeZone?: string; locale?: string }

const stamp = (t: number, o: FormatOptions) =>
  new Date(t).toLocaleString(o.locale, { timeZone: o.timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "Oct 10, 2:00 PM to Oct 17, 2:00 PM": the exact span, in the reader's zone. */
export function formatSpan(from: number, to: number, o: FormatOptions = {}): string {
  return `${stamp(from, o)} to ${stamp(to, o)}`;
}

/**
 * The line under the shipping sentence: the exact current and previous spans,
 * and that they roll with the clock. For a 7-day view the bars repeat the same
 * weekday a week earlier; for 30 days they do not, so only totals compare.
 */
export function comparisonCaption(series: FlowSeries, window: FlowWindow, o: FormatOptions = {}): string {
  const { from, to } = series.window;
  const days = window === '7d' ? 7 : 30;
  const prev = series.previous?.window;
  const current = `Rolling ${days} days: ${formatSpan(from, to, o)}.`;
  const before = prev ? ` Compared with ${formatSpan(prev.from, prev.to, o)}.` : '';
  const bars = ` Each bar covers 24 hours starting at ${new Date(from).toLocaleTimeString(o.locale, { timeZone: o.timeZone, hour: 'numeric', minute: '2-digit' })}, so bars do not follow calendar days.`;
  const align = window === '7d'
    ? ' Faint bars are the same weekday a week earlier.'
    : series.previous ? ' The 30 days before are compared in total, since their weekdays do not line up.' : '';
  return current + before + bars + align;
}

/** "Shipped 12 tasks in the last 7 days, up 20% on the 7 days before (10); median 5h from first agent start to production." */
export function shippingSentence(series: FlowSeries, window: FlowWindow): string {
  const n = series.headline.shippedTasks;
  const prev = series.previous?.shippedTasks;
  const { now, before } = PERIOD[window];
  let compare = '';
  if (prev != null) {
    if (prev === 0) compare = n > 0 ? `, none ${before}` : '';
    else if (n === prev) compare = `, the same as ${before}`;
    else {
      const pct = Math.round((Math.abs(n - prev) / prev) * 100);
      if (n === 0) compare = `, ${countOf(prev, 'task')} ${before}`;
      else if (pct === 0) compare = `, about the same as ${before} (${prev})`;
      else compare = `, ${n > prev ? 'up' : 'down'} ${pct}% on ${before} (${prev})`;
    }
  }
  const head = n === 0 ? `No tasks shipped ${now}${compare}` : `Shipped ${countOf(n, 'task')} ${now}${compare}`;
  const median = series.headline.medianStartToProdMs;
  return median != null && n > 0 ? `${head}; median ${formatDuration(median)} from first agent start to production.` : `${head}.`;
}

export interface TimeRow {
  category: TimeCategory;
  label: string;
  /** Cumulative across tasks: a detail beside the median, never the headline. */
  ms: number;
  medianMs: number;
  p90Ms: number;
  /** Of all task time in the window, 0..1. */
  share: number;
  tasks: number;
  href: string;
}

/** A share as a percentage; time that rounds to nothing still reads as some. */
export function formatTimeShare(share: number): string {
  if (share > 0 && share < 0.005) return '<1%';
  return `${Math.round(share * 100)}%`;
}

/** The rows of "What slowed work down?". The release row only appears when something waited for one. */
export function timeRows(series: FlowSeries): TimeRow[] {
  const total = series.time.reduce((m, r) => m + r.ms, 0);
  return series.time
    .filter(r => r.category !== 'release' || r.ms > 0)
    .map(r => ({
      category: r.category,
      label: TIME_LABEL[r.category],
      ms: r.ms,
      medianMs: r.medianMs,
      p90Ms: r.p90Ms,
      share: total > 0 ? r.ms / total : 0,
      tasks: r.tasks,
      href: timeTaskListHref(series, r.category),
    }));
}

/**
 * Up to three plain sentences naming what held work up, as how many tasks and
 * how long each waited (median and 90th percentile), never one summed total:
 * "40 days of waiting" reads as a wall-clock delay and is not. Ordered by
 * cumulative time so the biggest drains lead. Running is work, not a stall.
 */
export function stallSentences(series: FlowSeries): string[] {
  return series.time
    .filter(r => r.category !== 'running' && r.ms > 0 && r.tasks > 0)
    .sort((a, b) => b.ms - a.ms || TIME_CATEGORIES.indexOf(a.category) - TIME_CATEGORIES.indexOf(b.category))
    .slice(0, 3)
    .map(r => {
      // One item: say how long. Several: median and 90th percentile per item.
      const tail = r.tasks === 1 ? ` for ${formatDuration(r.ms)}` : `: median ${formatDuration(r.medianMs)}, 90th percentile ${formatDuration(r.p90Ms)}`;
      switch (r.category) {
        case 'needs_input': return `${countOf(r.tasks, 'task')} had a question waiting${tail}.`;
        case 'ci': return `${countOf(r.tasks, 'PR')} waited on CI runs that failed or are still going${tail}.`;
        case 'review': return `${countOf(r.tasks, 'PR')} sat in review${tail}.`;
        case 'runner': return `${countOf(r.tasks, 'task')} waited for a runner to pick them up${tail}.`;
        case 'retry': return `${countOf(r.tasks, 'task')} needed another attempt after a failure${tail}.`;
        case 'release': return `${countOf(r.tasks, 'merged task')} waited for a release${tail}.`;
        default: return `${TIME_LABEL[r.category]}: ${formatDuration(r.ms)}.`;
      }
    });
}

export interface DayBar {
  start: number;
  end: number;
  label: string;
  /** Exact span, e.g. "Sat Oct 10, 2:00 PM to Sun Oct 11, 2:00 PM". */
  range: string;
  /** Shorter than 24 hours: the window cut it. Drawn as such, never as a full day. */
  partial: boolean;
  shipped: number;
  lost: number;
  prevShipped: number | null;
  prevLost: number | null;
}

/**
 * One bar per 24 hours of the rolling window. The same slice of the window
 * before sits alongside only when it is the same weekday (7 days earlier); a
 * 30-day window shifts weekdays, so it compares in total instead.
 */
export function dayBars(series: FlowSeries, window: FlowWindow, o: FormatOptions = {}): DayBar[] {
  const prev = window === '7d' ? series.previous?.days ?? null : null;
  const dayStamp = (t: number) => new Date(t).toLocaleString(o.locale, { timeZone: o.timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return series.days.map((d, i) => {
    const p = prev?.[i];
    const aligned = p != null && p.start === d.start - 7 * DAY;
    return {
      start: d.start,
      end: d.end,
      // Named by the day the slice starts, in the reader's zone.
      label: window === '7d'
        ? new Date(d.start).toLocaleDateString(o.locale, { timeZone: o.timeZone, weekday: 'short' })
        : new Date(d.start).toLocaleDateString(o.locale, { timeZone: o.timeZone, month: 'short', day: 'numeric' }),
      range: `${dayStamp(d.start)} to ${dayStamp(d.end)}`,
      partial: d.end - d.start < DAY,
      shipped: d.shipped,
      lost: d.lost,
      prevShipped: aligned ? p!.shipped : null,
      prevLost: aligned ? p!.lost : null,
    };
  });
}

// ── The tasks behind a row ───────────────────────────────────────────────────

export function timeTaskListHref(series: FlowSeries, category: TimeCategory): string {
  return '/app/health/insights/tasks?' + new URLSearchParams({ split: category, from: String(series.window.from), to: String(series.window.to) });
}

export function parseSplitFilter(params: { split?: string; from?: string; to?: string }): { category: TimeCategory; from: number; to: number } | null {
  const { split } = params;
  const from = Number(params.from), to = Number(params.to);
  if (!split || !(TIME_CATEGORIES as readonly string[]).includes(split) || !params.from || !params.to) return null;
  if (![from, to].every(Number.isFinite) || !Object.values(WINDOW_MS).includes(to - from)) return null;
  return { category: split as TimeCategory, from, to };
}

/** Tasks that spent any time in `category` inside the window, most time first. */
export function tasksWithTime(series: FlowSeries, category: TimeCategory) {
  return series.tasks
    .filter(t => (t.time?.[category] ?? 0) > 0)
    .sort((a, b) => b.time![category] - a.time![category] || a.key.localeCompare(b.key));
}
