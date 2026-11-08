/**
 * Bounded structural tool-efficiency aggregate: the only analyser-derived value
 * that leaves the runner. Counts, timings, failure classes, finding kinds,
 * versions and coverage. No text, paths, fingerprints, claims or event ids.
 *
 * It is observational. A finding kind count is a heuristic signal, never a
 * score of the model, and it is never reduced to a "wasted calls" number.
 */

export const ANALYSER_VERSION = 'tea-v1';
export const TOOL_EFFICIENCY_SCHEMA_VERSION = 1;

export const FINDING_KINDS = [
  'identical_search_unchanged',
  'redundant_read_unchanged',
  'broad_search_rerun_unnarrowed',
  'command_quoting_retry',
  'poll_without_new_evidence',
  'failure_without_verification',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const REVIEW_KINDS = [
  'absence_from_limited_search',
  'failure_treated_as_absence',
  'success_after_failed_check',
  'claim_contradicted_by_output',
  'completion_without_verified_scope',
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const FAILURE_CLASSES = ['error', 'path_unavailable', 'denied', 'timeout', 'cancelled', 'nonzero_unmodeled'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface ToolEfficiencyAggregate {
  schemaVersion: typeof TOOL_EFFICIENCY_SCHEMA_VERSION;
  analyserVersion: string;
  harness: 'claude' | 'codex' | 'unknown';
  calls: number;
  findingKinds: Partial<Record<FindingKind, number>>;
  failureClasses: Partial<Record<FailureClass, number>>;
  timing: { observedCalls: number; totalMs: number; p50Ms: number | null; p90Ms: number | null; maxMs: number | null };
  coverage: { recorded: number; dropped: number; unobserved: number; sampledOut: number };
  /** Present only when the opt-in reviewer ran. Candidate counts by status; never ground truth. */
  review?: { reviewerVersion: string; candidates: number; confirmed: number; dismissed: number; kinds: Partial<Record<ReviewKind, number>> };
}

const MAX_COUNT = 1_000_000;
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COUNT ? Math.round(v) : null;
}
function countMap<K extends string>(raw: unknown, allowed: readonly K[]): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of allowed) {
    const n = count((raw as Record<string, unknown>)[k]);
    if (n !== null && n > 0) out[k] = n;
  }
  return out;
}

/** Whitelist an untrusted runner payload. Returns null unless it is a known-version aggregate. */
export function sanitizeToolEfficiency(raw: unknown): ToolEfficiencyAggregate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  if (r.schemaVersion !== TOOL_EFFICIENCY_SCHEMA_VERSION) return null;
  if (typeof r.analyserVersion !== 'string' || !/^[a-z0-9._-]{1,24}$/i.test(r.analyserVersion)) return null;
  const calls = count(r.calls);
  if (calls === null) return null;
  const t = r.timing ?? {};
  const c = r.coverage ?? {};
  const opt = (v: unknown) => count(v);
  const out: ToolEfficiencyAggregate = {
    schemaVersion: TOOL_EFFICIENCY_SCHEMA_VERSION,
    analyserVersion: r.analyserVersion,
    harness: r.harness === 'claude' || r.harness === 'codex' ? r.harness : 'unknown',
    calls,
    findingKinds: countMap(r.findingKinds, FINDING_KINDS),
    failureClasses: countMap(r.failureClasses, FAILURE_CLASSES),
    timing: {
      observedCalls: count(t.observedCalls) ?? 0,
      totalMs: Math.min(count(t.totalMs) ?? 0, MAX_COUNT * 1000),
      p50Ms: opt(t.p50Ms), p90Ms: opt(t.p90Ms), maxMs: opt(t.maxMs),
    },
    coverage: {
      recorded: count(c.recorded) ?? 0, dropped: count(c.dropped) ?? 0,
      unobserved: count(c.unobserved) ?? 0, sampledOut: count(c.sampledOut) ?? 0,
    },
  };
  const rv = r.review;
  if (rv && typeof rv === 'object' && typeof rv.reviewerVersion === 'string' && /^[a-z0-9._-]{1,24}$/i.test(rv.reviewerVersion)) {
    out.review = {
      reviewerVersion: rv.reviewerVersion,
      candidates: count(rv.candidates) ?? 0, confirmed: count(rv.confirmed) ?? 0, dismissed: count(rv.dismissed) ?? 0,
      kinds: countMap(rv.kinds, REVIEW_KINDS),
    };
  }
  return out;
}

/** Findings per 100 observed calls, per kind. Rates are descriptive only; null when there are no calls. */
export function findingRatesPer100(a: ToolEfficiencyAggregate): Partial<Record<FindingKind, number>> | null {
  if (a.calls <= 0) return null;
  const out: Partial<Record<FindingKind, number>> = {};
  for (const k of FINDING_KINDS) {
    const n = a.findingKinds[k];
    if (n) out[k] = Math.round((n / a.calls) * 10_000) / 100;
  }
  return out;
}

export interface ToolEfficiencySummary {
  /** Attempts that carried an aggregate, and attempts that did not (unknown, not zero). */
  withAggregate: number;
  withoutAggregate: number;
  analyserVersions: string[];
  calls: number;
  findingKinds: Partial<Record<FindingKind, number>>;
  failureClasses: Partial<Record<FailureClass, number>>;
  /** Mean of per-attempt median call time, over attempts that measured one. Null = none measured. */
  meanP50Ms: number | null;
  coverage: { recorded: number; dropped: number; unobserved: number; sampledOut: number };
  schemaVersions: number[];
  /**
   * Opt-in reviewer candidates, counted by status. `attempts` = attempts that carried a review block; the
   * rest never ran a reviewer (unknown, not zero). Candidates are never ground truth.
   */
  review: {
    attempts: number; reviewerVersions: string[];
    candidates: number; confirmed: number; dismissed: number;
    /** Still unresolved: candidates - confirmed - dismissed. */
    open: number;
    kinds: Partial<Record<ReviewKind, number>>;
  };
}

/** Fold per-attempt aggregates for one configuration. Mixed analyser versions are listed, not merged away. */
export function summarizeToolEfficiency(items: ReadonlyArray<ToolEfficiencyAggregate | null | undefined>): ToolEfficiencySummary {
  const s: ToolEfficiencySummary = {
    withAggregate: 0, withoutAggregate: 0, analyserVersions: [], calls: 0,
    findingKinds: {}, failureClasses: {}, meanP50Ms: null,
    coverage: { recorded: 0, dropped: 0, unobserved: 0, sampledOut: 0 },
    schemaVersions: [],
    review: { attempts: 0, reviewerVersions: [], candidates: 0, confirmed: 0, dismissed: 0, open: 0, kinds: {} },
  };
  const versions = new Set<string>();
  const schemas = new Set<number>();
  const reviewers = new Set<string>();
  const p50s: number[] = [];
  for (const a of items) {
    if (!a) { s.withoutAggregate++; continue; }
    s.withAggregate++;
    versions.add(a.analyserVersion);
    schemas.add(a.schemaVersion);
    s.calls += a.calls;
    for (const k of FINDING_KINDS) if (a.findingKinds[k]) s.findingKinds[k] = (s.findingKinds[k] ?? 0) + a.findingKinds[k]!;
    for (const k of FAILURE_CLASSES) if (a.failureClasses[k]) s.failureClasses[k] = (s.failureClasses[k] ?? 0) + a.failureClasses[k]!;
    if (a.timing.p50Ms !== null) p50s.push(a.timing.p50Ms);
    s.coverage.recorded += a.coverage.recorded;
    s.coverage.dropped += a.coverage.dropped;
    s.coverage.unobserved += a.coverage.unobserved;
    s.coverage.sampledOut += a.coverage.sampledOut;
    if (a.review) {
      s.review.attempts++;
      reviewers.add(a.review.reviewerVersion);
      s.review.candidates += a.review.candidates;
      s.review.confirmed += a.review.confirmed;
      s.review.dismissed += a.review.dismissed;
      for (const k of REVIEW_KINDS) if (a.review.kinds[k]) s.review.kinds[k] = (s.review.kinds[k] ?? 0) + a.review.kinds[k]!;
    }
  }
  s.review.open = Math.max(0, s.review.candidates - s.review.confirmed - s.review.dismissed);
  s.review.reviewerVersions = [...reviewers].sort();
  s.schemaVersions = [...schemas].sort((x, y) => x - y);
  s.analyserVersions = [...versions].sort();
  if (p50s.length) s.meanP50Ms = Math.round(p50s.reduce((x, y) => x + y, 0) / p50s.length);
  return s;
}
