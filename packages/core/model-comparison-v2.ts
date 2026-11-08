/**
 * Per-category capability profile of controlled v2 replay runs
 * (docs/specs/coding-eval-playground.md section 11). Pure: it reads the
 * `evaluation.v2` block that ingestion stored on each row.
 *
 * Rules: dev and sealed-holdout are never pooled; a harness or infra error is
 * a count beside the pass rate, never a model failure; an unmeasured number is
 * null, never zero; there is no composite score, rank or winner; a flagged
 * conclusion is a candidate that needs independent confirmation, not a verdict.
 */
import { newcombeInterval, wilsonInterval, type Interval } from './stat-intervals';
import type { RunDetailV2 } from './local-eval';

/** What the profile reads from a stored row (a subset of ComparisonRow). */
export interface V2Row {
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  retries?: number | null;
  peakVramMb?: number | null;
  evaluation?: { suiteVersion?: string; caseId?: string; configId?: string; trial?: number; runId?: string; result?: string; v2?: RunDetailV2 } | null;
}

export const isV2Row = (r: V2Row): boolean => r.evaluation?.suiteVersion === 'v2' && !!r.evaluation.v2;

export interface V2Rate { k: number; n: number; rate: number | null; interval: Interval | null }
export interface V2Num { known: number; unknown: number; median: number | null; max: number | null }

export interface CategoryProfile {
  category: string;
  /** Graded model attempts: pass + fail + invalid. Errors and unscored are counted apart. */
  rate: V2Rate;
  cases: number;
  trials: number;
  /** Spread of per-case pass rates across trials: cases whose trials disagreed. */
  mixedCases: number;
  errors: { model: number; harness: number; infra: number };
  unscored: number;
  invalid: number;
  latencyMs: V2Num;
  inputTokens: V2Num;
  outputTokens: V2Num;
  peakVramMb: V2Num;
  retries: number;
  flags: Record<string, number>;
  /** Drilldown from graders, averaged over the runs that recorded it; null when none did. */
  drilldown: {
    reviewPrecision: V2Rate | null;
    reviewRecall: V2Rate | null;
    citations: V2Rate | null;
    regressionSuccess: V2Rate | null;
    invariants: V2Rate | null;
    /** Mean constraint retention per stage index across runs that recorded stages. */
    retentionByStage: Array<{ stage: number; mean: number; runs: number }>;
  };
}

export interface ConfigSplitProfile { split: string; categories: CategoryProfile[]; skills: Array<{ skill: string; rate: V2Rate }>; runs: number }
export interface UnsupportedConclusionCandidate {
  runId: string; caseId: string; configId: string; split: string; reason: string;
  /** Always true: a flag raises a candidate; a person or an independent check confirms or clears it. */
  needsIndependentConfirmation: true;
}

export interface V2Paired {
  split: string; a: string; b: string; commonCases: number; nA: number; nB: number;
  difference: number | null; interval: Interval | null;
  verdict: 'insufficient_n' | 'a_higher' | 'a_lower' | 'no_detectable_difference';
}

export interface V2Profile {
  design: 'controlled_v2_profile';
  note: string;
  configs: Array<{ configId: string; splits: ConfigSplitProfile[] }>;
  paired: V2Paired[];
  candidates: UnsupportedConclusionCandidate[];
  /** Always not_computed: a capability profile is not a ranking. */
  verdict: 'not_computed' | 'no_runs';
}

const rate = (k: number, n: number): V2Rate => ({ k, n, rate: n > 0 ? k / n : null, interval: n > 0 ? wilsonInterval(k, n) : null });
function num(values: Array<number | null | undefined>): V2Num {
  const known = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!known.length) return { known: 0, unknown: values.length, median: null, max: null };
  return { known: known.length, unknown: values.length - known.length, median: known[Math.min(known.length - 1, Math.ceil(known.length / 2) - 1)], max: known[known.length - 1] };
}
const FLAGS_CONFIRM = new Set(['fabrication', 'wrong_abstention', 'followed_superseded', 'constraint_dropped']);

function ratioRate(rows: V2Row[], pick: (d: NonNullable<RunDetailV2['detail']>) => [number | null | undefined, number | null | undefined]): V2Rate | null {
  let k = 0; let n = 0; let any = false;
  for (const r of rows) {
    const d = r.evaluation?.v2?.detail; if (!d) continue;
    const [a, b] = pick(d);
    if (typeof a === 'number' && typeof b === 'number' && b > 0) { k += a; n += b; any = true; }
  }
  return any ? rate(Math.round(k), Math.round(n)) : null;
}

function categoryProfile(category: string, rows: V2Row[]): CategoryProfile {
  const ev = (r: V2Row) => r.evaluation!;
  const graded = rows.filter((r) => ['pass', 'fail', 'invalid'].includes(ev(r).result ?? ''));
  const passes = graded.filter((r) => ev(r).result === 'pass').length;
  const byCase = new Map<string, { n: number; k: number }>();
  for (const r of graded) { const c = byCase.get(ev(r).caseId ?? '?') ?? { n: 0, k: 0 }; c.n++; if (ev(r).result === 'pass') c.k++; byCase.set(ev(r).caseId ?? '?', c); }
  const errs = { model: 0, harness: 0, infra: 0 };
  const flags: Record<string, number> = {};
  for (const r of rows) {
    const v = ev(r).v2!;
    if (ev(r).result === 'error') { const c = v.failureClass === 'infra' ? 'infra' : 'harness'; errs[c]++; }
    else if (v.failureClass === 'model' && ev(r).result !== 'pass') errs.model++;
    for (const f of v.flags ?? []) flags[f] = (flags[f] ?? 0) + 1;
  }
  const stages = new Map<number, number[]>();
  for (const r of rows) (r.evaluation?.v2?.detail?.retention ?? []).forEach((v, i) => { if (typeof v === 'number') stages.set(i, [...(stages.get(i) ?? []), v]); });
  const precisionRows = rows.filter((r) => r.evaluation?.v2?.detail?.precision != null);
  const recallRows = rows.filter((r) => r.evaluation?.v2?.detail?.recall != null);
  const meanRate = (rs: V2Row[], f: 'precision' | 'recall'): V2Rate | null => {
    if (!rs.length) return null;
    const mean = rs.reduce((s, r) => s + (r.evaluation!.v2!.detail![f] as number), 0) / rs.length;
    return { k: Math.round(mean * rs.length), n: rs.length, rate: mean, interval: null };
  };
  const regRows = rows.filter((r) => typeof r.evaluation?.v2?.detail?.regressionPassed === 'boolean');
  return {
    category,
    rate: rate(passes, graded.length),
    cases: byCase.size,
    trials: rows.length,
    mixedCases: [...byCase.values()].filter((c) => c.k > 0 && c.k < c.n).length,
    errors: errs,
    unscored: rows.filter((r) => ev(r).result === 'unscored').length,
    invalid: rows.filter((r) => ev(r).result === 'invalid').length,
    latencyMs: num(rows.map((r) => r.durationMs)),
    inputTokens: num(rows.map((r) => r.inputTokens)),
    outputTokens: num(rows.map((r) => r.outputTokens)),
    peakVramMb: num(rows.map((r) => r.peakVramMb)),
    retries: rows.reduce((s, r) => s + (r.retries ?? 0) + (ev(r).v2?.retries ?? 0), 0),
    flags,
    drilldown: {
      reviewPrecision: meanRate(precisionRows, 'precision'),
      reviewRecall: meanRate(recallRows, 'recall'),
      citations: ratioRate(rows, (d) => [d.citationsCorrect, d.citationsTotal]),
      regressionSuccess: regRows.length ? rate(regRows.filter((r) => r.evaluation!.v2!.detail!.regressionPassed === true).length, regRows.length) : null,
      invariants: ratioRate(rows, (d) => [d.invariantsPassed, d.invariantsTotal]),
      retentionByStage: [...stages.entries()].sort(([a], [b]) => a - b).map(([stage, v]) => ({ stage, mean: v.reduce((s, x) => s + x, 0) / v.length, runs: v.length })),
    },
  };
}

export function buildV2Profile(rows: readonly V2Row[], opts: { minResolved: number }): V2Profile {
  const v2 = rows.filter(isV2Row);
  const group = <T,>(items: T[], key: (t: T) => string) => { const m = new Map<string, T[]>(); for (const i of items) { const k = key(i); m.set(k, [...(m.get(k) ?? []), i]); } return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)); };
  const configs = group(v2, (r) => r.evaluation!.configId ?? 'config unknown').map(([configId, g]) => ({
    configId,
    // dev and sealed-holdout stay in their own rows.
    splits: group(g, (r) => r.evaluation!.v2!.split).map(([split, sr]): ConfigSplitProfile => ({
      split,
      runs: sr.length,
      categories: group(sr, (r) => r.evaluation!.v2!.category).map(([c, cr]) => categoryProfile(c, cr)),
      skills: group(sr.filter((r) => ['pass', 'fail', 'invalid'].includes(r.evaluation!.result ?? '')).flatMap((r) => (r.evaluation!.v2!.skills ?? []).map((s) => ({ s, pass: r.evaluation!.result === 'pass' }))), (x) => x.s)
        .map(([skill, xs]) => ({ skill, rate: rate(xs.filter((x) => x.pass).length, xs.length) })),
    })),
  }));

  // Paired: two configs, same split, same cases, trial-level counts over the common cases.
  const paired: V2Paired[] = [];
  for (let i = 0; i < configs.length; i++) for (let j = i + 1; j < configs.length; j++) {
    for (const split of new Set([...configs[i].splits, ...configs[j].splits].map((s) => s.split))) {
      const tally = (configId: string) => {
        const m = new Map<string, { k: number; n: number }>();
        for (const r of v2) {
          const e = r.evaluation!;
          if (e.configId !== configId || e.v2!.split !== split || !['pass', 'fail', 'invalid'].includes(e.result ?? '')) continue;
          const c = m.get(e.caseId ?? '?') ?? { k: 0, n: 0 }; c.n++; if (e.result === 'pass') c.k++; m.set(e.caseId ?? '?', c);
        }
        return m;
      };
      const ta = tally(configs[i].configId); const tb = tally(configs[j].configId);
      const common = [...ta.keys()].filter((c) => tb.has(c));
      const sum = (t: Map<string, { k: number; n: number }>) => common.reduce((s, c) => ({ k: s.k + t.get(c)!.k, n: s.n + t.get(c)!.n }), { k: 0, n: 0 });
      const a = sum(ta); const b = sum(tb);
      if (!common.length) continue;
      const base = { split, a: configs[i].configId, b: configs[j].configId, commonCases: common.length, nA: a.n, nB: b.n };
      if (a.n < opts.minResolved || b.n < opts.minResolved) { paired.push({ ...base, difference: null, interval: null, verdict: 'insufficient_n' }); continue; }
      const d = newcombeInterval(a.k, a.n, b.k, b.n);
      paired.push({ ...base, difference: d.difference, interval: { lower: d.lower, upper: d.upper }, verdict: d.lower > 0 ? 'a_higher' : d.upper < 0 ? 'a_lower' : 'no_detectable_difference' });
    }
  }

  const candidates: UnsupportedConclusionCandidate[] = [];
  for (const r of v2) {
    const e = r.evaluation!; const v = e.v2!;
    const hit = (v.flags ?? []).filter((f) => FLAGS_CONFIRM.has(f));
    const reasons = [...hit, ...(v.absenceClaimed && e.result === 'pass' ? ['absence claimed (needs a second searcher)'] : [])];
    if (reasons.length) candidates.push({ runId: e.runId ?? '?', caseId: e.caseId ?? '?', configId: e.configId ?? '?', split: v.split, reason: reasons.join(', '), needsIndependentConfirmation: true });
  }
  candidates.sort((a, b) => a.runId.localeCompare(b.runId));

  return {
    design: 'controlled_v2_profile',
    note: 'Per-category capability profile on authored, dev-split cases unless a row says sealed-holdout. Dev and holdout are never pooled. Errors from the harness or the host are counted beside a pass rate, not in it. Nothing here is a composite score or a ranking. A flagged conclusion is a candidate until someone confirms it independently.',
    configs,
    paired,
    candidates,
    verdict: v2.length ? 'not_computed' : 'no_runs',
  };
}
