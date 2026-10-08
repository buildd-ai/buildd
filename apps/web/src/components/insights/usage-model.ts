import type { FlowSeries } from '@/lib/insights-flow';
import { BAND_LABEL, tasksInBand, type BandKey } from './flow-chart-model';
import { BASIS_KEYS, basisOfRow, type BasisKey } from '@/lib/cost-basis-split';

export type UsageRow = NonNullable<FlowSeries['usage']>[number];

/** A row's bucket: its basis, or unknown when it carries usage without one. */
const basisOf = (row: UsageRow) => basisOfRow(row.basis, { costUsd: row.costUsd, inputTokens: row.tokens });

interface Totals { role: string; tokens: number; costUsd: number; realUsd: number; virtualUsd: number; hours: number }
function add(into: Totals, row: UsageRow) {
  into.tokens += row.tokens; into.costUsd += row.costUsd; into.hours += row.hours;
  const basis = basisOf(row);
  if (basis === 'real') into.realUsd += row.costUsd;
  if (basis === 'virtual') into.virtualUsd += row.costUsd;
}

/**
 * Per role and tier. `costUsd` is the combined figure; `realUsd` and
 * `virtualUsd` are the two shown, so mixed and unknown cost appear in neither
 * (they are reported on their own by `usageByBasis`).
 */
export function usageByRole(rows: UsageRow[]) {
  const groups = new Map<string, Totals & { tiers: (Totals & { tier: string })[] }>();
  const zero = (role: string) => ({ role, tokens: 0, costUsd: 0, realUsd: 0, virtualUsd: 0, hours: 0 });
  for (const row of rows) {
    let group = groups.get(row.role);
    if (!group) { group = { ...zero(row.role), tiers: [] }; groups.set(row.role, group); }
    const tier = ['standard', 'premium', 'premium-plus', 'budget'].includes(row.tier ?? '') ? row.tier! : 'unknown';
    let split = group.tiers.find(t => t.tier === tier);
    if (!split) { split = { ...zero(row.role), tier }; group.tiers.push(split); }
    add(group, row); add(split, row);
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens || a.role.localeCompare(b.role));
}

type Cell = { workers: number; tokens: number; costUsd: number };
type Split = Record<BasisKey, Cell>;
const emptyCells = (): Split => Object.fromEntries(BASIS_KEYS.map(k => [k, { workers: 0, tokens: 0, costUsd: 0 }])) as Split;

/** Tokens and cost per basis, overall and per executor (docs/specs/real-and-virtual-cost.md). */
export function usageByBasis(rows: UsageRow[]) {
  const total = emptyCells();
  const byExecutor = { interactive: emptyCells(), runner: emptyCells(), other: emptyCells() };
  let combinedUsd = 0;
  for (const row of rows) {
    // A run that started before the window is attributed no tokens or cost here.
    if (row.tokens <= 0 && row.costUsd <= 0) continue;
    const basis = basisOf(row);
    if (!basis) continue;
    for (const split of [total, byExecutor[row.executor ?? 'runner']]) {
      split[basis].workers += 1; split[basis].tokens += row.tokens; split[basis].costUsd += row.costUsd;
    }
    combinedUsd += row.costUsd;
  }
  return { total, byExecutor, combinedUsd };
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
