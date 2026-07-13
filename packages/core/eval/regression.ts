/**
 * Retrieval eval regression comparison — pure, dependency-free.
 *
 * Compares a fresh eval run's aggregate metrics against a committed baseline
 * (`packages/core/eval/retrieval-baseline.json`) and flags any metric that has
 * regressed by more than a relative threshold (default 20%). Used by the CI
 * retrieval-eval gate (`.github/workflows/knowledge-eval.yml`).
 *
 * "Regression" is a RELATIVE drop: current < baseline * (1 - threshold). A
 * metric that improves, holds, or dips by ≤ threshold passes. A baseline of 0
 * can never regress (you cannot fall below the floor), so it is reported but
 * never fails the gate.
 */

export interface AggregateMetrics {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcg10?: number;
}

export interface MetricComparison {
  metric: keyof AggregateMetrics;
  baseline: number;
  current: number;
  /** Relative change (current - baseline) / baseline; null when baseline is 0. */
  relativeDelta: number | null;
  regressed: boolean;
}

export interface RegressionReport {
  pass: boolean;
  threshold: number;
  comparisons: MetricComparison[];
  /** Subset of comparisons that regressed (pass === regressions.length === 0). */
  regressions: MetricComparison[];
}

/** Default relative-regression tolerance: fail on a drop of more than 20%. */
export const DEFAULT_REGRESSION_THRESHOLD = 0.2;

/** Metrics compared, in report order. `ndcg10` is optional in either side. */
const METRIC_KEYS: Array<keyof AggregateMetrics> = ['recallAt5', 'recallAt10', 'mrr', 'ndcg10'];

/**
 * Compare current aggregate metrics against a baseline.
 *
 * A metric is only compared when it is a finite number in BOTH sides (so a
 * baseline that omits `ndcg10` simply skips it rather than failing). An
 * exact-threshold drop is NOT a regression — only a drop strictly greater than
 * the threshold fails (with a tiny epsilon to absorb float noise).
 */
export function compareMetrics(
  current: Partial<AggregateMetrics>,
  baseline: Partial<AggregateMetrics>,
  threshold: number = DEFAULT_REGRESSION_THRESHOLD,
): RegressionReport {
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(`compareMetrics: threshold must be a finite number >= 0, got ${threshold}`);
  }

  const comparisons: MetricComparison[] = [];
  for (const key of METRIC_KEYS) {
    const b = baseline[key];
    const c = current[key];
    if (typeof b !== 'number' || !Number.isFinite(b)) continue;
    if (typeof c !== 'number' || !Number.isFinite(c)) continue;

    let relativeDelta: number | null;
    let regressed: boolean;
    if (b === 0) {
      // Nothing to regress below — any non-negative current holds the floor.
      relativeDelta = null;
      regressed = false;
    } else {
      relativeDelta = (c - b) / b;
      regressed = relativeDelta < -threshold - 1e-9;
    }
    comparisons.push({ metric: key, baseline: b, current: c, relativeDelta, regressed });
  }

  const regressions = comparisons.filter(c => c.regressed);
  return { pass: regressions.length === 0, threshold, comparisons, regressions };
}

/** Human-readable, one-line-per-metric summary for CI logs. */
export function formatRegressionReport(report: RegressionReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(
    `Retrieval regression gate: ${report.pass ? 'PASS' : 'FAIL'} ` +
      `(threshold ${pct(report.threshold)} relative drop)`,
  );
  for (const c of report.comparisons) {
    const deltaStr =
      c.relativeDelta === null ? 'n/a (baseline 0)' : `${c.relativeDelta >= 0 ? '+' : ''}${pct(c.relativeDelta)}`;
    const flag = c.regressed ? '  ✗ REGRESSED' : '';
    lines.push(
      `  ${String(c.metric).padEnd(11)} baseline=${c.baseline.toFixed(4)} ` +
        `current=${c.current.toFixed(4)}  Δ=${deltaStr}${flag}`,
    );
  }
  if (!report.pass) {
    lines.push(
      `\n${report.regressions.length} metric(s) regressed beyond the ${pct(report.threshold)} threshold.`,
    );
  }
  return lines.join('\n');
}
