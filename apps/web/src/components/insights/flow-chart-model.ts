/**
 * The flow stages ("bands") behind the Insights drill-down, and the duration
 * formatters Insights and Usage share. Pure, so it is tested without a DOM.
 */
import type { FlowSeries, FlowTask } from '@/lib/insights-flow';

export type BandKey = 'running' | 'waiting' | 'review' | 'merged' | 'released' | 'lost';

export const BAND_LABEL: Record<BandKey, string> = {
  running: 'Agents running',
  waiting: 'Has a question',
  review: 'In review / CI',
  merged: 'Merged, not released',
  released: 'Released',
  lost: 'Failed or abandoned',
};

/** Tasks that were in `band` during bucket `i`, longest overlap first. */
export function tasksInBand(series: FlowSeries, i: number, band: BandKey): FlowTask[] {
  const b = series.buckets[i];
  if (!b) return [];
  const { from } = series.window;
  if (band === 'released') {
    return series.tasks.filter(t => t.shippedAt != null && t.shippedAt >= from && t.shippedAt < b.end)
      .sort((a, z) => z.shippedAt! - a.shippedAt!);
  }
  if (band === 'lost') {
    return series.tasks.filter(t => t.lostAt != null && t.lostAt >= from && t.lostAt < b.end)
      .sort((a, z) => z.lostAt! - a.lostAt!);
  }
  const scored = series.tasks.map(t => ({
    t,
    ms: t.segments
      .filter(s => s.stage === band)
      .reduce((m, s) => m + Math.max(0, Math.min(s.to, b.end) - Math.max(s.from, b.start)), 0),
  }));
  return scored.filter(x => x.ms > 0).sort((a, z) => z.ms - a.ms).map(x => x.t);
}

/** Agent-hours by role inside the window, largest first. */
export function roleHours(series: FlowSeries): { role: string; hours: number }[] {
  const by = new Map<string, number>();
  for (const b of series.buckets) {
    for (const [role, v] of Object.entries(b.running)) by.set(role, (by.get(role) ?? 0) + v * (b.end - b.start) / 3_600_000);
  }
  return [...by].map(([role, hours]) => ({ role, hours })).sort((a, z) => z.hours - a.hours || a.role.localeCompare(z.role));
}

export function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 10) return `${h.toFixed(1)}h`;
  return `${Math.round(h)}h`;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return '';
  const h = ms / 3_600_000;
  if (h < 48) return formatHours(h);
  return `${(h / 24).toFixed(h < 240 ? 1 : 0)}d`;
}

export function formatShare(share: number | null): string {
  return share == null ? '' : `${Math.round(share * 100)}%`;
}
