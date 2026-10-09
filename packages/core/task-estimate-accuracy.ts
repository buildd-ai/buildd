/**
 * The live readout of the task-estimates model: how close were the frozen
 * estimates to what the finished tasks actually took?
 *
 * The scoring is the backtest's (`./estimate-backtest.ts`: `scoreRows`,
 * `buildBacktestReport`, `bandFor`), called, not copied, so a live number and a
 * replayed number are one definition: share of actuals within p80, median
 * actual / p50 (the typical overrun), median |ln(actual / p50)|. The unit is
 * agent minutes, the same measure `actualOf` gives the replay. Tokens are
 * scored the same way as a second column.
 *
 * Sliced by what the estimate leaned on (`bySource`: the evidence with the
 * largest weight in the frozen explanation), by task kind, by area cluster
 * (the explanation's label) and by workspace history size (the learning curve:
 * completed tasks when the estimate was made).
 *
 * Never pooled across estimator versions, like task-area-readout's arms: a
 * version redefines what an estimate is, so a readout is for exactly one. The
 * caller passes one version's rows and `computeTaskEstimateReadout` refuses
 * a mix rather than averaging it.
 *
 * Pure: rows in, a readout out. The query is `./task-estimate-accuracy-source.ts`.
 */
import { buildBacktestReport, scoreRows, type BacktestRow, type BacktestScore } from './estimate-backtest';
import type { TaskEstimateExplanation } from './db/schema';

export type LiveSource = 'neighbours' | 'clusters' | 'prior' | 'default';

export const LIVE_SOURCES: readonly LiveSource[] = ['neighbours', 'clusters', 'prior', 'default'];

/** A frozen estimate joined to its task's actuals. */
export interface LiveEstimateRow {
  taskId: string;
  workspaceId: string;
  estimatorVersion: string;
  p50Minutes: number;
  p80Minutes: number;
  p50Tokens: number;
  p80Tokens: number;
  expectedRepairs: number;
  actualMinutes: number;
  actualTokens: number;
  actualRepairs: number;
  kind: string | null;
  explanation: Pick<TaskEstimateExplanation, 'sources' | 'clusterLabel'>;
  /** Completed tasks the workspace had when the estimate was made. */
  priorCompleted: number;
}

export interface GroupScore { key: string; score: BacktestScore }

export interface TaskEstimateReadout {
  estimatorVersion: string | null;
  rows: number;
  overall: BacktestScore;
  tokens: BacktestScore;
  /** Mean expected repairs vs mean repairs the tasks needed. */
  repairs: { expected: number; actual: number } | null;
  bySource: GroupScore[];
  byKind: GroupScore[];
  byCluster: GroupScore[];
  byHistory: Array<{ band: string; score: BacktestScore }>;
  /** True when nothing is scorable yet: "cannot see", not "the estimates are fine". */
  indeterminate: boolean;
}

/** The source carrying the most weight in the explanation; 'default' when it had none. */
export function primarySource(e: Pick<TaskEstimateExplanation, 'sources'>): LiveSource {
  let best: { source: LiveSource; weight: number } | null = null;
  for (const s of e.sources ?? []) {
    if (!best || s.weight > best.weight) best = { source: s.source, weight: s.weight };
  }
  return best?.source ?? 'default';
}

/** The backtest's row shape. `source` is the backtest's own vocabulary and unused by the slices below. */
export function toBacktestRow(r: LiveEstimateRow): BacktestRow {
  return {
    source: r.explanation.sources.some(s => s.source === 'neighbours') ? 'neighbours' : r.explanation.sources.length > 0 ? 'bucket' : 'none',
    p50: r.p50Minutes,
    p80: r.p80Minutes,
    actual: r.actualMinutes,
    priorCompleted: r.priorCompleted,
  };
}

function groupScores(rows: readonly LiveEstimateRow[], keyOf: (r: LiveEstimateRow) => string, order?: readonly string[]): GroupScore[] {
  const groups = new Map<string, LiveEstimateRow[]>();
  for (const r of rows) (groups.get(keyOf(r)) ?? groups.set(keyOf(r), []).get(keyOf(r))!).push(r);
  const out = [...groups].map(([key, rs]) => ({ key, score: scoreRows(rs.map(toBacktestRow)) }));
  if (order) return out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return out.sort((a, b) => b.score.n - a.score.n || a.key.localeCompare(b.key));
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function computeTaskEstimateReadout(rows: readonly LiveEstimateRow[]): TaskEstimateReadout {
  const versions = [...new Set(rows.map(r => r.estimatorVersion))];
  if (versions.length > 1) {
    throw new Error(`task-estimate readout is per estimator version; got ${versions.join(', ')}. Filter to one.`);
  }
  const bt = rows.map(toBacktestRow);
  const report = buildBacktestReport(bt);
  const tokens = scoreRows(rows.map(r => ({ p50: r.p50Tokens, p80: r.p80Tokens, actual: r.actualTokens })));
  return {
    estimatorVersion: versions[0] ?? null,
    rows: rows.length,
    overall: report.overall,
    tokens,
    repairs: rows.length ? { expected: mean(rows.map(r => r.expectedRepairs)), actual: mean(rows.map(r => r.actualRepairs)) } : null,
    bySource: groupScores(rows, r => primarySource(r.explanation), LIVE_SOURCES),
    byKind: groupScores(rows, r => r.kind ?? 'unknown'),
    byCluster: groupScores(rows, r => r.explanation.clusterLabel ?? 'none'),
    byHistory: report.byHistory,
    indeterminate: report.overall.scored === 0,
  };
}
