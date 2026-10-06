import type { FlowSeries } from '@/lib/insights-flow';
import { BAND_LABEL, tasksInBand, type BandKey } from './flow-chart-model';

export type UsageRow = NonNullable<FlowSeries['usage']>[number];
export function usageByRole(rows: UsageRow[]) {
  const groups = new Map<string, { role: string; tokens: number; costUsd: number; hours: number; tiers: (UsageRow & { tier: string })[] }>();
  for (const row of rows) {
    let group = groups.get(row.role);
    if (!group) { group = { role: row.role, tokens: 0, costUsd: 0, hours: 0, tiers: [] }; groups.set(row.role, group); }
    const tier = ['standard', 'premium', 'premium-plus', 'budget'].includes(row.tier ?? '') ? row.tier! : 'unknown';
    let split = group.tiers.find(t => t.tier === tier);
    if (!split) { split = { role: row.role, tier, tokens: 0, costUsd: 0, hours: 0 }; group.tiers.push(split); }
    for (const key of ['tokens', 'costUsd', 'hours'] as const) { group[key] += row[key]; split[key] += row[key]; }
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens || a.role.localeCompare(b.role));
}
function counts(values: string[]) {
  const by = new Map<string, number>();
  for (const value of values) by.set(value, (by.get(value) ?? 0) + 1);
  return [...by].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
export function summarizeBand(series: FlowSeries, index: number, band: BandKey) {
  const tasks = tasksInBand(series, index, band);
  const recentAt = (t: typeof tasks[number]) => t.shippedAt ?? t.lostAt ?? Math.max(0, ...t.segments.map(s => s.to));
  return {
    total: tasks.length,
    roles: counts(tasks.map(t => t.role)),
    workspaces: counts(tasks.map(t => series.workspaceNames?.[t.workspaceId] ?? 'Unknown workspace')),
    outcomes: counts(tasks.map(t => t.shippedAt != null ? 'Released' : t.lostAt != null ? 'Failed or abandoned' : t.outcome ?? 'In flight')),
    recent: [...tasks].sort((a, b) => recentAt(b) - recentAt(a) || a.key.localeCompare(b.key)).slice(0, 5),
  };
}
export function bandTaskListHref(series: FlowSeries, index: number, band: BandKey) {
  return '/app/health/insights/tasks?' + new URLSearchParams({ band, from: String(series.window.from), to: String(series.window.to), at: String(series.buckets[index].start) });
}
export function parseBandFilter(params: { band?: string; from?: string; to?: string; at?: string }) {
  const { band } = params;
  const from = Number(params.from), to = Number(params.to), at = Number(params.at);
  if (!band || !Object.hasOwn(BAND_LABEL, band) || !params.from || !params.to || !params.at || ![from, to, at].every(Number.isFinite) || to <= from || ![7 * 86400000, 30 * 86400000].includes(to - from) || at < from || at >= to) return null;
  return { band: band as BandKey, from, to, at };
}
