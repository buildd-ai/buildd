/**
 * Pure scoring for the model comparison (`./compare.ts`): one model's answers
 * over one kind's cases, read for calibration, a precision/coverage sweep and
 * the threshold that model could act at. No I/O.
 *
 * Two confidence sources are read per model, because they differ by model:
 *   - `confidence`: the answer's own confidence field;
 *   - `top_p`: the probability of the chosen label.
 * Jev's two agree. Clef's `confidence` is compressed (it rarely passes ~0.45,
 * even when right) while its top p is usable, so a threshold read off the
 * wrong field says "never act" about a model that could. Every threshold is
 * reported with the source it was read from.
 *
 * A threshold is derived on the Wilson lower bound of precision, not the point
 * estimate: 60 of 64 right is 94% but proves little.
 */

export const CONFIDENCE_SOURCES = ['confidence', 'top_p'] as const;
export type ConfidenceSource = (typeof CONFIDENCE_SOURCES)[number];

/** Default kind target precision and minimum labelled cases before a threshold is derived. */
export const DEFAULT_TARGET_PRECISION = 0.9;
export const DEFAULT_MIN_LABELLED = 50;

/** 0, 0.05, …, 0.95, then 0.97 and 0.99. */
export const DEFAULT_SWEEP: readonly number[] = [
  ...Array.from({ length: 20 }, (_, i) => Math.round(i * 5) / 100),
  0.97,
  0.99,
];

const Z95 = 1.959964;

/** One case as one model answered it. */
export interface ScoredCase {
  /** The model's label; null when it gave none (an error). */
  label: string | null;
  /** Was it right? Null: the case has no gold that says (excluded from every rate but agreement). An error is false. */
  correct: boolean | null;
  confidence: number | null;
  topP: number | null;
  /** Was the rule right on this case? Absent or null: no rule answer. */
  ruleCorrect?: boolean | null;
  /** The production model's label on the same case, when it was asked too. */
  prodLabel?: string | null;
  latencyMs?: number | null;
}

/** 95% Wilson score lower bound of a binomial proportion. 0 when n is 0. */
export function wilsonLower(successes: number, n: number): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/** Nearest-rank percentile; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

const signalOf = (c: ScoredCase, source: ConfidenceSource) => (source === 'confidence' ? c.confidence : c.topP);
const labelled = (cases: readonly ScoredCase[]) => cases.filter(c => c.correct !== null);

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanSignal: number | null;
  accuracy: number | null;
}

export interface Reliability {
  /** Labelled cases that carry this signal. */
  n: number;
  /** Expected calibration error: count-weighted |mean signal - accuracy| over the bins. Null with no cases. */
  ece: number | null;
  bins: ReliabilityBin[];
}

/** Ten equal-width bins over [0, 1]; 1.0 falls in the last. */
export function reliability(cases: readonly ScoredCase[], source: ConfidenceSource, binCount = 10): Reliability {
  const bins = Array.from({ length: binCount }, (_, i) => ({ lo: i / binCount, hi: (i + 1) / binCount, n: 0, sum: 0, right: 0 }));
  let n = 0;
  for (const c of labelled(cases)) {
    const v = signalOf(c, source);
    if (v === null || !Number.isFinite(v)) continue;
    const b = bins[Math.min(binCount - 1, Math.max(0, Math.floor(v * binCount)))];
    b.n++;
    b.sum += v;
    if (c.correct) b.right++;
    n++;
  }
  const ece = n === 0 ? null : bins.reduce((acc, b) => (b.n ? acc + (b.n / n) * Math.abs(b.sum / b.n - b.right / b.n) : acc), 0);
  return {
    n,
    ece,
    bins: bins.map(b => ({ lo: b.lo, hi: b.hi, n: b.n, meanSignal: b.n ? b.sum / b.n : null, accuracy: b.n ? b.right / b.n : null })),
  };
}

export interface SweepRow {
  threshold: number;
  /** Labelled cases whose signal is at or above the threshold: the ones that would be acted on. */
  covered: number;
  correct: number;
  /** covered / labelled cases (an error is labelled and never covered). */
  coverage: number;
  precision: number | null;
  wilsonLower: number | null;
}

export function sweep(cases: readonly ScoredCase[], source: ConfidenceSource, thresholds: readonly number[] = DEFAULT_SWEEP): SweepRow[] {
  const pool = labelled(cases);
  return thresholds.map(threshold => {
    const covered = pool.filter(c => c.label !== null && (signalOf(c, source) ?? -1) >= threshold);
    const correct = covered.filter(c => c.correct).length;
    return {
      threshold,
      covered: covered.length,
      correct,
      coverage: pool.length ? covered.length / pool.length : 0,
      precision: covered.length ? correct / covered.length : null,
      wilsonLower: covered.length ? wilsonLower(correct, covered.length) : null,
    };
  });
}

export type ThresholdReason = 'too_few_labelled' | 'no_signal' | 'no_threshold_meets_bar';

export interface DerivedThreshold {
  source: ConfidenceSource;
  /** The lowest threshold that qualifies; null with `reason`. */
  threshold: number | null;
  reason: ThresholdReason | null;
  /** The precision bar: max(rule accuracy, kind target). */
  bar: number;
  labelled: number;
  minLabelled: number;
  precision: number | null;
  wilsonLower: number | null;
  coverage: number | null;
}

export interface ThresholdOptions {
  target: number;
  minLabelled: number;
  ruleAccuracy: number | null;
  thresholds?: readonly number[];
}

/**
 * The lowest threshold whose Wilson lower bound on precision is at least
 * max(rule accuracy, target), once the kind has `minLabelled` labelled cases.
 */
export function deriveThreshold(cases: readonly ScoredCase[], source: ConfidenceSource, opts: ThresholdOptions): DerivedThreshold {
  const bar = Math.max(opts.ruleAccuracy ?? 0, opts.target);
  const n = labelled(cases).length;
  const base = { source, bar, labelled: n, minLabelled: opts.minLabelled, precision: null, wilsonLower: null, coverage: null };
  if (n < opts.minLabelled) return { ...base, threshold: null, reason: 'too_few_labelled' };
  if (!labelled(cases).some(c => signalOf(c, source) !== null)) return { ...base, threshold: null, reason: 'no_signal' };
  const hit = sweep(cases, source, opts.thresholds ?? DEFAULT_SWEEP)
    .find(r => r.covered > 0 && r.wilsonLower !== null && r.wilsonLower >= bar);
  if (!hit) return { ...base, threshold: null, reason: 'no_threshold_meets_bar' };
  return { ...base, threshold: hit.threshold, reason: null, precision: hit.precision, wilsonLower: hit.wilsonLower, coverage: hit.coverage };
}

export interface ModelScore {
  /** Cases asked (answered, errored or unlabelled). */
  n: number;
  /** Cases with gold. */
  labelled: number;
  answered: number;
  /** Correct / labelled; an error counts as wrong. Null with nothing labelled. */
  accuracy: number | null;
  /** The rule on the same labelled cases. */
  ruleAccuracy: number | null;
  /** Same label as the production model, over cases both answered. */
  agreement: number | null;
  agreementN: number;
  calibration: Record<ConfidenceSource, Reliability>;
  sweep: Record<ConfidenceSource, SweepRow[]>;
  thresholds: Record<ConfidenceSource, DerivedThreshold>;
  /** The threshold to use and the source it is read from: the qualifying one covering more. Null when none qualifies. */
  derived: { source: ConfidenceSource; threshold: number; coverage: number; precision: number; wilsonLower: number } | null;
  derivedReason: ThresholdReason | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

export function scoreModel(cases: readonly ScoredCase[], opts: ThresholdOptions): ModelScore {
  const pool = labelled(cases);
  const withRule = pool.filter(c => c.ruleCorrect !== undefined && c.ruleCorrect !== null);
  const ruleAccuracy = withRule.length ? withRule.filter(c => c.ruleCorrect).length / withRule.length : opts.ruleAccuracy;
  const both = cases.filter(c => c.label !== null && c.prodLabel !== undefined && c.prodLabel !== null);
  const thresholdOpts = { ...opts, ruleAccuracy };
  const thresholds = {
    confidence: deriveThreshold(cases, 'confidence', thresholdOpts),
    top_p: deriveThreshold(cases, 'top_p', thresholdOpts),
  };
  const calibration = { confidence: reliability(cases, 'confidence'), top_p: reliability(cases, 'top_p') };

  const qualifying = CONFIDENCE_SOURCES.map(s => thresholds[s]).filter(t => t.threshold !== null);
  qualifying.sort((a, b) =>
    (b.coverage ?? 0) - (a.coverage ?? 0)
    || (calibration[a.source].ece ?? 1) - (calibration[b.source].ece ?? 1)
    || CONFIDENCE_SOURCES.indexOf(a.source) - CONFIDENCE_SOURCES.indexOf(b.source));
  const best = qualifying[0];
  const reasons = CONFIDENCE_SOURCES.map(s => thresholds[s].reason);
  const derivedReason: ThresholdReason | null = best
    ? null
    : reasons.includes('too_few_labelled') ? 'too_few_labelled'
    : reasons.includes('no_threshold_meets_bar') ? 'no_threshold_meets_bar'
    : 'no_signal';
  const latencies = cases.map(c => c.latencyMs).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  return {
    n: cases.length,
    labelled: pool.length,
    answered: cases.filter(c => c.label !== null).length,
    accuracy: pool.length ? pool.filter(c => c.correct).length / pool.length : null,
    ruleAccuracy: ruleAccuracy ?? null,
    agreement: both.length ? both.filter(c => c.label === c.prodLabel).length / both.length : null,
    agreementN: both.length,
    calibration,
    sweep: {
      confidence: sweep(cases, 'confidence', opts.thresholds),
      top_p: sweep(cases, 'top_p', opts.thresholds),
    },
    thresholds,
    derived: best
      ? { source: best.source, threshold: best.threshold!, coverage: best.coverage!, precision: best.precision!, wilsonLower: best.wilsonLower! }
      : null,
    derivedReason,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
  };
}
