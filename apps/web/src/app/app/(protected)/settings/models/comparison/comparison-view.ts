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

/** v2 profile wording. A rate always shows the runs behind it; a unit with no runs says so. */
export function v2RateText(r: { k: number; n: number; rate: number | null; interval: { lower: number; upper: number } | null } | null): string {
  if (!r || r.n === 0 || r.rate === null) return NOT_RECORDED;
  const range = r.interval ? `, ${pct(r.interval.lower)} to ${pct(r.interval.upper)}` : '';
  return `${pct(r.rate)} (${r.k} of ${r.n}${range})`;
}

export const SPLIT_LABEL: Record<string, string> = { dev: 'Dev cases', 'sealed-holdout': 'Sealed holdout', prospective: 'Prospective' };

export function categoryTitle(c: string): string {
  const t = c.replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const REPLAY_EMPTY = 'No evaluation runs.';
