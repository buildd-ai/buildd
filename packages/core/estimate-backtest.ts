/**
 * Scoring for a task-size estimate backtest: how close were estimates to what
 * the work actually took? Pure — rows in, a report out. The replay that
 * produces the rows (and enforces that each estimate saw only data older than
 * its task) is `./estimate-backtest-source.ts`.
 *
 * An estimate is a p50 and, optionally, a p80 (the current estimator only has
 * a point value, so p80 is null and those rows are left out of coverage). The
 * unit is whatever the caller passes — the harness uses agent minutes.
 */

export type EstimateSource = 'neighbours' | 'bucket' | 'none';

export const ESTIMATE_SOURCES: readonly EstimateSource[] = ['neighbours', 'bucket', 'none'];

export interface BacktestRow {
  source: EstimateSource;
  /** Null when the estimator produced nothing (source 'none'). */
  p50: number | null;
  p80: number | null;
  actual: number;
  /** Completed tasks the workspace had when this task was created. */
  priorCompleted: number;
}

export interface BacktestScore {
  /** Rows scored. */
  n: number;
  /** Rows that carried an estimate p50 and a positive actual. */
  scored: number;
  /** Share of rows with a p80 whose actual was ≤ p80; null with no such rows. */
  withinP80: number | null;
  /** Median actual / p50; 1 is unbiased, >1 means estimates run low. */
  medianRatio: number | null;
  /** Median |ln(actual / p50)|; 0 is perfect, ln 2 ≈ 0.69 is "off by 2×". */
  medianAbsLogError: number | null;
}

export interface LearningCurveBand {
  label: string;
  min: number;
  max: number;
}

/** Completed tasks in the workspace at creation time. */
export const LEARNING_CURVE_BANDS: readonly LearningCurveBand[] = [
  { label: '0', min: 0, max: 0 },
  { label: '1-9', min: 1, max: 9 },
  { label: '10-49', min: 10, max: 49 },
  { label: '50+', min: 50, max: Number.POSITIVE_INFINITY },
];

export interface BacktestReport {
  overall: BacktestScore;
  bySource: Record<EstimateSource, BacktestScore>;
  byHistory: Array<{ band: string; score: BacktestScore }>;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const usable = (x: number | null): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

export function scoreRows(rows: readonly BacktestRow[]): BacktestScore {
  const ratios: number[] = [];
  let p80Rows = 0;
  let p80Hits = 0;
  for (const r of rows) {
    if (!usable(r.actual)) continue;
    if (usable(r.p50)) ratios.push(r.actual / r.p50);
    if (usable(r.p80)) {
      p80Rows++;
      if (r.actual <= r.p80) p80Hits++;
    }
  }
  const absLogs = ratios.map(x => Math.abs(Math.log(x)));
  return {
    n: rows.length,
    scored: ratios.length,
    withinP80: p80Rows ? p80Hits / p80Rows : null,
    medianRatio: median(ratios),
    medianAbsLogError: median(absLogs),
  };
}

export function bandFor(priorCompleted: number): string {
  const n = Math.max(0, Math.floor(priorCompleted));
  return (LEARNING_CURVE_BANDS.find(b => n >= b.min && n <= b.max) ?? LEARNING_CURVE_BANDS[0]).label;
}

export function buildBacktestReport(rows: readonly BacktestRow[]): BacktestReport {
  const bySource = {} as Record<EstimateSource, BacktestScore>;
  for (const s of ESTIMATE_SOURCES) bySource[s] = scoreRows(rows.filter(r => r.source === s));
  return {
    overall: scoreRows(rows),
    bySource,
    byHistory: LEARNING_CURVE_BANDS.map(b => ({
      band: b.label,
      score: scoreRows(rows.filter(r => bandFor(r.priorCompleted) === b.label)),
    })),
  };
}

const pct = (x: number | null) => (x === null ? '–' : `${(x * 100).toFixed(0)}%`);
const num = (x: number | null, d = 2) => (x === null ? '–' : x.toFixed(d));

function line(label: string, s: BacktestScore): string {
  return `| ${label} | ${s.n} | ${s.scored} | ${pct(s.withinP80)} | ${num(s.medianRatio)} | ${num(s.medianAbsLogError)} |`;
}

export function formatBacktestReport(r: BacktestReport, title = 'Estimate backtest'): string {
  const head = '| | tasks | scored | within p80 | median actual/p50 | median abs log err |\n|---|---|---|---|---|---|';
  return [
    `## ${title}`,
    '',
    head,
    line('overall', r.overall),
    '',
    '### By estimate source',
    head,
    ...ESTIMATE_SOURCES.map(s => line(s, r.bySource[s])),
    '',
    '### Learning curve (completed tasks in workspace at creation)',
    head,
    ...r.byHistory.map(b => line(b.band, b.score)),
    '',
  ].join('\n');
}
