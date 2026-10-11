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
  needs_input: 'Needs input',
  ci: 'Waiting for CI',
  review: 'In review',
  runner: 'Waiting for a runner',
  running: 'Running',
  retry: 'Retries after failure',
  release: 'Waiting for a release',
};

const PERIOD: Record<FlowWindow, { now: string; before: string }> = {
  '7d': { now: 'this week', before: 'last week' },
  '30d': { now: 'in the last 30 days', before: 'the 30 days before' },
};

/** "Shipped 12 tasks this week, up 20% on last week; median 5h from start to production." */
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
      compare = n === 0 ? `, ${countOf(prev, 'task')} ${before}` : `, ${n > prev ? 'up' : 'down'} ${pct}% on ${before}`;
    }
  }
  const head = n === 0 ? `No tasks shipped ${now}${compare}` : `Shipped ${countOf(n, 'task')} ${now}${compare}`;
  const median = series.headline.medianStartToProdMs;
  return median != null && n > 0 ? `${head}; median ${formatDuration(median)} from start to production.` : `${head}.`;
}

export interface TimeRow {
  category: TimeCategory;
  label: string;
  ms: number;
  /** Of all task time in the window, 0..1. */
  share: number;
  tasks: number;
  href: string;
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
      share: total > 0 ? r.ms / total : 0,
      tasks: r.tasks,
      href: timeTaskListHref(series, r.category),
    }));
}

/** Up to three plain sentences naming what held work up most, largest first. Running is work, not a stall. */
export function stallSentences(series: FlowSeries): string[] {
  return series.time
    .filter(r => r.category !== 'running' && r.ms > 0 && r.tasks > 0)
    .sort((a, b) => b.ms - a.ms || TIME_CATEGORIES.indexOf(a.category) - TIME_CATEGORIES.indexOf(b.category))
    .slice(0, 3)
    .map(r => {
      const h = formatDuration(r.ms);
      const longest = r.tasks > 1 ? `; the longest was ${formatDuration(r.longestMs)}` : '';
      switch (r.category) {
        case 'needs_input': return `${countOf(r.tasks, 'task')} needed input for ${h} in all${longest}.`;
        case 'ci': return `${countOf(r.tasks, 'PR')} waited ${h} for CI runs that failed or are still going${longest}.`;
        case 'review': return `${countOf(r.tasks, 'PR')} sat in review for ${h}${longest}.`;
        case 'runner': return `${countOf(r.tasks, 'task')} waited ${h} for a runner to pick them up${longest}.`;
        case 'retry': return `Fixing failures took ${h} of agent time on ${countOf(r.tasks, 'task')}.`;
        case 'release': return `${countOf(r.tasks, 'merged task')} waited ${h} for a release${longest}.`;
        default: return `${TIME_LABEL[r.category]}: ${h}.`;
      }
    });
}

export interface DayBar { start: number; end: number; label: string; shipped: number; lost: number; prevShipped: number | null; prevLost: number | null }

/** One bar per 24 hours, with the same slice of the window before alongside. */
export function dayBars(series: FlowSeries, window: FlowWindow): DayBar[] {
  const prev = series.previous?.days ?? null;
  return series.days.map((d, i) => {
    const mid = new Date(d.start + (d.end - d.start) / 2);
    return {
      start: d.start,
      end: d.end,
      label: window === '7d'
        ? mid.toLocaleDateString(undefined, { weekday: 'short' })
        : mid.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      shipped: d.shipped,
      lost: d.lost,
      prevShipped: prev?.[i]?.shipped ?? null,
      prevLost: prev?.[i]?.lost ?? null,
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
