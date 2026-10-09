/**
 * Blend arm for the estimate backtest: today's estimator (neighbour median,
 * bucket fallback) and the blended estimator (task-estimate.ts) scored on the
 * SAME tasks, never pooled. A blend that is not better is a complete result;
 * the UI task waits on this verdict.
 */
import { LEARNING_CURVE_BANDS, bandFor, scoreRows, type BacktestRow, type BacktestScore } from './estimate-backtest';

export interface PairedRow {
  taskId: string;
  actual: number;
  priorCompleted: number;
  current: { p50: number | null; p80: number | null };
  /** Which arm of the current estimator answered: neighbours, or the bucket fallback. */
  currentSource?: 'neighbours' | 'bucket' | 'none';
  blend: { p50: number; p80: number };
}

export interface BlendComparison {
  overall: { current: BacktestScore; blend: BacktestScore };
  byHistory: Array<{ band: string; current: BacktestScore; blend: BacktestScore }>;
  /** The bar the mission set: is the blend better than neighbours ALONE, on the rows neighbours answered? */
  byCurrentSource: Array<{ source: string; current: BacktestScore; blend: BacktestScore }>;
  verdict: 'blend_better' | 'no_better' | 'insufficient';
}

const asRows = (rows: readonly PairedRow[], arm: 'current' | 'blend'): BacktestRow[] =>
  rows.map(r => ({ source: 'neighbours', p50: r[arm].p50, p80: r[arm].p80, actual: r.actual, priorCompleted: r.priorCompleted }));

/** Better = lower median |log error| by at least 0.05 (about 5%) over at least 30 scored tasks. */
export function compareBlend(rows: readonly PairedRow[]): BlendComparison {
  const current = scoreRows(asRows(rows, 'current'));
  const blend = scoreRows(asRows(rows, 'blend'));
  const byHistory = LEARNING_CURVE_BANDS.map(b => {
    const inBand = rows.filter(r => bandFor(r.priorCompleted) === b.label);
    return { band: b.label, current: scoreRows(asRows(inBand, 'current')), blend: scoreRows(asRows(inBand, 'blend')) };
  });
  const byCurrentSource = (['neighbours', 'bucket'] as const).map(src => {
    const sub = rows.filter(r => r.currentSource === src);
    return { source: src, current: scoreRows(asRows(sub, 'current')), blend: scoreRows(asRows(sub, 'blend')) };
  });
  const enough = Math.min(current.scored, blend.scored) >= 30;
  const c = current.medianAbsLogError, k = blend.medianAbsLogError;
  const verdict = !enough || c === null || k === null ? 'insufficient' : k <= c - 0.05 ? 'blend_better' : 'no_better';
  return { overall: { current, blend }, byHistory, byCurrentSource, verdict };
}

const f = (x: number | null, d = 2) => (x === null ? '–' : x.toFixed(d));
const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);

export function formatBlendComparison(c: BlendComparison): string {
  const line = (label: string, cur: BacktestScore, bl: BacktestScore) =>
    `${label.padEnd(10)} n=${String(cur.scored).padStart(4)}  log-err ${f(cur.medianAbsLogError)} → ${f(bl.medianAbsLogError)}  ratio ${f(cur.medianRatio)} → ${f(bl.medianRatio)}  within p80 ${pct(cur.withinP80)} → ${pct(bl.withinP80)}`;
  return [
    'Blend vs current estimator (same tasks; arrow = current → blend)',
    line('overall', c.overall.current, c.overall.blend),
    ...c.byHistory.map(h => line(`history ${h.band}`, h.current, h.blend)),
    ...c.byCurrentSource.map(h => line(`on ${h.source} rows`, h.current, h.blend)),
    `Verdict: ${c.verdict === 'blend_better' ? 'the blend is better' : c.verdict === 'no_better' ? 'the blend is not better than the current estimator' : 'not enough scored tasks to decide'}.`,
  ].join('\n');
}
