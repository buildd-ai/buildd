/**
 * View model for Health > Estimates: the readout (packages/core
 * task-estimate-accuracy.ts) in the words a person reads. Pure and client-safe.
 */
import type { TaskEstimateReadout } from '@buildd/core/task-estimate-accuracy';

type BacktestScore = TaskEstimateReadout['overall'];

export interface ScatterPoint { estimate: number; actual: number }

export const MIN_SCORED_FOR_VERDICT = 10;

export interface Headline { lead: string; basis: string | null }

/** The result first. Below the minimum it says so rather than guessing. */
export function estimatesHeadline(overall: BacktestScore): Headline {
  if (overall.scored < MIN_SCORED_FOR_VERDICT || overall.withinP80 == null) {
    return { lead: 'Not enough finished tasks yet to judge the estimates.', basis: overall.scored > 0 ? `Based on ${overall.scored} ${overall.scored === 1 ? 'task' : 'tasks'} so far.` : null };
  }
  const inTen = Math.round(overall.withinP80 * 10);
  const basis = `Based on ${overall.scored} tasks.`;
  if (overall.withinP80 >= 0.7) {
    return { lead: inTen >= 10 ? 'Almost every task finished within estimate.' : 'Most tasks finished within estimate.', basis: `${inTen} in 10 finished within the upper estimate. ${basis}` };
  }
  return { lead: 'Many tasks ran past their estimate.', basis: `Only ${inTen} in 10 finished within the upper estimate. ${basis}` };
}

/** "on target", "about 1.5x longer than estimated" from median actual / p50. */
export function typicalLine(score: BacktestScore): string {
  const r = score.medianRatio;
  if (r == null) return 'n/a';
  if (r >= 0.85 && r <= 1.15) return 'on target';
  const x = r > 1 ? r : 1 / r;
  return `${x >= 10 ? Math.round(x) : x.toFixed(1)}x ${r > 1 ? 'longer' : 'shorter'}`;
}

export const pct = (v: number | null) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);

const SOURCE_LABEL: Record<string, string> = {
  neighbours: 'Similar tasks', clusters: 'Same area', prior: 'New-repo prior', default: 'No evidence',
};
export const sourceLabel = (k: string) => SOURCE_LABEL[k] ?? k;

/** Log-scale position in [0,1] of v within [lo, hi]. */
export function logPos(v: number, lo: number, hi: number): number {
  const a = Math.log(Math.max(v, lo));
  return (a - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1);
}

/** Axis bounds that hold every point on a log scale, as round minute values. */
export function scatterBounds(points: readonly ScatterPoint[]): { lo: number; hi: number } {
  if (points.length === 0) return { lo: 1, hi: 100 };
  const vals = points.flatMap(p => [p.estimate, p.actual]).filter(v => v > 0);
  const lo = Math.max(1, Math.floor(Math.min(...vals)));
  const hi = Math.max(lo * 10, Math.ceil(Math.max(...vals)));
  return { lo, hi };
}

/** The p80 band's width as a multiple of the p50, the median across rows. */
export function medianBandRatio(rows: ReadonlyArray<{ p50: number; p80: number }>): number {
  const rs = rows.filter(r => r.p50 > 0 && r.p80 >= r.p50).map(r => r.p80 / r.p50).sort((a, b) => a - b);
  return rs.length ? rs[Math.floor(rs.length / 2)] : 1.5;
}
