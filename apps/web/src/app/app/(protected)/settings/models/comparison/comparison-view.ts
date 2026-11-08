/**
 * What the comparison page says, as plain data. Kept out of the component so
 * the wording and the unknown rules are testable without rendering.
 *
 * Rules: an unknown is said as "Not recorded" (never 0, never an em dash), a
 * rate shows how many attempts it rests on, and no row is ever called a winner.
 */
import type {
  ComparisonVerdict, ConfigSummary, MatchedComparison, NumericStat, PairComparison, RateStat, SampleStatus,
} from '@buildd/core/model-comparison';

export const NOT_RECORDED = 'Not recorded';

export const pct = (v: number) => `${Math.round(v * 100)}%`;

export function rateText(r: RateStat): { value: string; detail: string } {
  if (r.n === 0 || r.rate === null) {
    return { value: NOT_RECORDED, detail: r.unknown > 0 ? `${r.unknown} with no review, CI or merge result` : 'No attempts' };
  }
  const range = r.interval ? `${pct(r.interval.lower)} to ${pct(r.interval.upper)}` : '';
  const more = r.unknown > 0 ? `, ${r.unknown} not recorded` : '';
  return { value: pct(r.rate), detail: `${r.k} of ${r.n}, ${range}${more}` };
}

export function durationText(ms: number | null): string {
  if (ms === null) return NOT_RECORDED;
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  const m = s / 60;
  return m < 90 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`;
}

export function numericText(s: NumericStat, fmt: (n: number) => string, pick: 'mean' | 'median' = 'median'): { value: string; detail: string } {
  const v = s[pick];
  if (v === null) return { value: NOT_RECORDED, detail: '' };
  return { value: fmt(v), detail: s.unknown > 0 ? `${s.known} of ${s.known + s.unknown} attempts` : `${s.known} attempts` };
}

export const tokensText = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

export function costText(c: ConfigSummary['cost']): { value: string; detail: string } {
  if (c.knownCount === 0 || c.knownUsd === null) return { value: NOT_RECORDED, detail: 'No priced attempts' };
  return {
    value: `$${c.knownUsd.toFixed(2)}`,
    detail: c.unknownCount > 0 ? `known cost of ${c.knownCount} attempts, ${c.unknownCount} without a cost` : `${c.knownCount} attempts`,
  };
}

export function sampleLabel(s: SampleStatus, min: number): { tone: 'ok' | 'act' | 'q'; label: string; title: string } {
  if (s === 'established') return { tone: 'ok', label: 'Enough attempts', title: `At least ${min} attempts with a recorded result` };
  if (s === 'small_sample') return { tone: 'act', label: 'Small sample', title: `Fewer than ${min} attempts with a recorded result. Treat as a hint.` };
  return { tone: 'q', label: 'No results', title: 'No attempt has a review, CI or merge result' };
}

export function verdictLine(v: ComparisonVerdict, a: string, b: string, subject: string): string {
  switch (v) {
    case 'insufficient_n': return `Too few attempts to compare ${subject}.`;
    case 'no_detectable_difference': return `No detectable difference between ${a} and ${b}.`;
    case 'a_higher': return `${a} has a higher rate than ${b}.`;
    case 'a_lower': return `${a} has a lower rate than ${b}.`;
  }
}

export function coverageLines(c: ConfigSummary): string[] {
  const n = c.attempts;
  const out: string[] = [];
  const add = (count: number, what: string) => { if (count > 0) out.push(`${what} not recorded for ${count} of ${n}`); };
  add(c.coverage.modelVersionUnknown, 'Model version');
  add(c.coverage.quantizationUnknown, 'Quantization');
  add(c.coverage.hardwareUnknown, 'Hardware');
  add(c.coverage.harnessUnknown, 'Harness');
  add(c.coverage.taskClassUnknown, 'Task type');
  return out;
}

export function pairLabel(m: MatchedComparison | PairComparison): { a: string; b: string } {
  return { a: m.a, b: m.b };
}

export const EVIDENCE_NOTICE = {
  title: 'Observed in production',
  body: 'Production attempts, routed rather than randomised. This page never changes routing.',
} as const;

export interface ToolEfficiencyView {
  /** Null when no attempt carried an analysed trace: the block says so rather than showing zeros. */
  empty: string | null;
  /** Counted directly from the trace. */
  measured: string[];
  /** Heuristic signals. Candidates only: never a score, never ground truth. */
  estimated: string[];
  coverage: string[];
  review: string[];
  versions: string;
}

const FINDING_LABEL: Record<string, string> = {
  identical_search_unchanged: 'identical search repeated on unchanged files',
  redundant_read_unchanged: 'file re-read with no change',
  broad_search_rerun_unnarrowed: 'broad search re-run without narrowing',
  command_quoting_retry: 'command retried after a quoting error',
  poll_without_new_evidence: 'repeated checks with no new result',
  failure_without_verification: 'failure never followed by a check',
};
const FAILURE_LABEL: Record<string, string> = {
  error: 'errors', path_unavailable: 'path unavailable', denied: 'denied', timeout: 'timeouts', cancelled: 'cancelled', nonzero_unmodeled: 'other non-zero exits',
};
const REVIEW_LABEL: Record<string, string> = {
  absence_from_limited_search: 'absence from a limited search',
  failure_treated_as_absence: 'failure read as absence',
  success_after_failed_check: 'success after a failed check',
  claim_contradicted_by_output: 'claim contradicted by output',
  completion_without_verified_scope: 'completion without verified scope',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function toolEfficiencyView(c: ConfigSummary): ToolEfficiencyView {
  const t = c.toolEfficiency;
  const noAgg = t.withoutAggregate;
  const total = t.withAggregate + noAgg;
  if (t.withAggregate === 0) {
    return { empty: `Tool use not recorded for ${plural(total, 'attempt')}.`, measured: [], estimated: [], coverage: [], review: [], versions: '' };
  }
  const measured = [`${t.calls} tool calls across ${plural(t.withAggregate, 'attempt')}${noAgg > 0 ? `, ${noAgg} not recorded` : ''}`];
  if (t.meanP50Ms !== null) measured.push(`median call time about ${durationText(t.meanP50Ms)}`);
  for (const [k, n] of Object.entries(t.failureClasses)) measured.push(`${n} ${FAILURE_LABEL[k] ?? k}`);
  const estimated = Object.entries(t.findingKinds).map(([k, n]) => `${n} ${FINDING_LABEL[k] ?? k}`);
  const cov = t.coverage;
  const coverage = [`${cov.recorded} calls recorded`];
  if (cov.dropped > 0) coverage.push(`${cov.dropped} dropped`);
  if (cov.unobserved > 0) coverage.push(`${cov.unobserved} without an observed result`);
  if (cov.sampledOut > 0) coverage.push(`${cov.sampledOut} sampled out`);
  const r = t.review;
  const review: string[] = [];
  if (r.attempts > 0) {
    review.push(`${plural(r.candidates, 'candidate')}: ${r.open} open, ${r.confirmed} confirmed, ${r.dismissed} dismissed (${plural(r.attempts, 'attempt')} reviewed)`);
    for (const [k, n] of Object.entries(r.kinds)) review.push(`${n} ${REVIEW_LABEL[k] ?? k}`);
  }
  const versions = `Analyser ${t.analyserVersions.join(', ')}, schema ${t.schemaVersions.join(', ')}${r.reviewerVersions.length ? `, reviewer ${r.reviewerVersions.join(', ')}` : ''}`;
  return { empty: null, measured, estimated, coverage, review, versions };
}

/** Where a candidate is corrected: on the machine that holds the trace, never on this page. */
export const CORRECTION_NOTE = 'Heuristic candidates. Confirm or dismiss on the runner with tool-trace report.';
