/**
 * Blended task estimate: one p50/p80 for minutes and tokens, plus expected
 * repairs, from three evidence sources.
 *
 * - neighbours: the k nearest completed tasks (`./task-size-estimate.ts`).
 * - clusters: the area clusters the task maps to (`./task-area-clusters.ts`).
 * - prior: a cross-workspace table of aggregates per (kind, size bucket).
 *
 * Local evidence (neighbours + clusters) is pooled weighted by n, then blended
 * with the prior cell using w_local = n_local / (n_local + k0). Minutes and
 * tokens blend in log space because durations are right-skewed; repairs blend
 * linearly. Pure: no DB, no env, no network.
 *
 * The prior carries aggregates only (numbers keyed by enum values). It never
 * carries text from a workspace, so it is safe to share across tenants.
 */
import type { TaskEstimateExplanation } from './db/schema';

export const ESTIMATOR_VERSION = 'blend-v1';

export type TaskKind = string;
export type SizeBucket = 'S' | 'M' | 'L';

export const SIZE_BUCKETS: readonly SizeBucket[] = ['S', 'M', 'L'];

/** Cross-workspace prior: aggregates ONLY. Numbers and enum keys, never strings from a workspace. */
export interface PriorCell { n: number; p50Minutes: number; p80Minutes: number; p50Tokens: number; p80Tokens: number; repairsPerTask: number }
export type PriorTable = Partial<Record<TaskKind, Partial<Record<SizeBucket, PriorCell>>>>;
export interface NeighbourEvidence { n: number; p50Minutes: number; p80Minutes: number; p50Tokens: number; p80Tokens: number }
export interface ClusterEvidence { n: number; label: string | null; p50Minutes: number; p80Minutes: number; p50Tokens: number; p80Tokens: number; repairsPerTask: number }
export interface EstimateInputs {
  kind: TaskKind | null;
  bucket: SizeBucket | null;
  neighbours: NeighbourEvidence | null;
  clusters: ClusterEvidence | null;
  prior: PriorTable;
  /** Local evidence weight is n/(n+k0) against the prior. Config, not a constant. */
  k0: number;
}
export interface TaskEstimateResult {
  p50Minutes: number; p80Minutes: number; p50Tokens: number; p80Tokens: number; expectedRepairs: number;
  explanation: TaskEstimateExplanation;
}

/**
 * Returned when there is no local history and the prior table is empty.
 * Deliberately on the high side: an under-estimate costs more than an
 * over-estimate when nothing is known.
 */
export const DEFAULT_ESTIMATE = {
  p50Minutes: 45,
  p80Minutes: 90,
  p50Tokens: 150_000,
  p80Tokens: 300_000,
  expectedRepairs: 0.5,
} as const;

interface Quad { p50Minutes: number; p80Minutes: number; p50Tokens: number; p80Tokens: number }

const QUAD_KEYS = ['p50Minutes', 'p80Minutes', 'p50Tokens', 'p80Tokens'] as const;

const pos = (x: number) => Number.isFinite(x) && x > 0;
const validQuad = (q: Quad) => QUAD_KEYS.every((k) => pos(q[k]));
const usable = <T extends Quad & { n: number }>(e: T | null | undefined): e is T =>
  !!e && Number.isFinite(e.n) && e.n > 0 && validQuad(e);

/** Weighted geometric mean of each quad field. Weights need not sum to 1. */
function logBlend(items: ReadonlyArray<{ q: Quad; w: number }>): Quad {
  const total = items.reduce((s, i) => s + i.w, 0);
  const out = {} as Quad;
  for (const k of QUAD_KEYS) {
    out[k] = Math.exp(items.reduce((s, i) => s + i.w * Math.log(i.q[k]), 0) / total);
  }
  return out;
}

function cellsOf(byBucket: Partial<Record<SizeBucket, PriorCell>> | undefined): PriorCell[] {
  if (!byBucket) return [];
  return SIZE_BUCKETS.map((b) => byBucket[b]).filter((c): c is PriorCell => !!c && validQuad(c));
}

/**
 * Prior cell for (kind, bucket), falling back to the kind's 'M' cell, then any
 * cell for the kind, then an n-weighted log-space average of every cell.
 */
export function lookupPrior(prior: PriorTable, kind: TaskKind | null, bucket: SizeBucket | null): PriorCell | null {
  const byBucket = kind != null ? prior[kind] : undefined;
  if (byBucket) {
    const exact = bucket ? byBucket[bucket] : undefined;
    if (exact && validQuad(exact)) return exact;
    const m = byBucket.M;
    if (m && validQuad(m)) return m;
    const any = cellsOf(byBucket)[0];
    if (any) return any;
  }
  const all = Object.values(prior).flatMap((b) => cellsOf(b));
  if (all.length === 0) return null;
  const items = all.map((c) => ({ q: c, w: Math.max(c.n, 1) }));
  const wsum = items.reduce((s, i) => s + i.w, 0);
  return {
    ...logBlend(items),
    n: all.reduce((s, c) => s + Math.max(c.n, 0), 0),
    repairsPerTask: items.reduce((s, i) => s + i.w * (Number.isFinite(i.q.repairsPerTask) ? i.q.repairsPerTask : 0), 0) / wsum,
  };
}

/** Weight the prior gets against n local samples. n=0 gives 1, n=k0 gives 0.5. */
export function priorWeightFor(nLocal: number, k0: number): number {
  const n = Math.max(0, nLocal);
  const k = Math.max(0, k0);
  if (n + k === 0) return 0;
  return k / (n + k);
}

const clampP80 = (q: Quad): Quad => ({
  ...q,
  p80Minutes: Math.max(q.p80Minutes, q.p50Minutes),
  p80Tokens: Math.max(q.p80Tokens, q.p50Tokens),
});

export function estimateTask(inputs: EstimateInputs): TaskEstimateResult {
  const nb = usable(inputs.neighbours) ? inputs.neighbours : null;
  const cl = usable(inputs.clusters) ? inputs.clusters : null;
  const prior = lookupPrior(inputs.prior, inputs.kind, inputs.bucket);
  const clusterLabel = inputs.clusters?.label ?? null;

  const locals = [
    ...(nb ? [{ source: 'neighbours' as const, n: nb.n, q: nb as Quad }] : []),
    ...(cl ? [{ source: 'clusters' as const, n: cl.n, q: cl as Quad }] : []),
  ];
  const nLocal = locals.reduce((s, l) => s + l.n, 0);

  if (locals.length === 0 && !prior) {
    const base = { ...DEFAULT_ESTIMATE };
    const e = { sources: [], clusterLabel, priorWeight: 1 };
    return { ...base, explanation: { ...e, summary: formatEstimateSummary(base, e, inputs.kind) } };
  }

  const wPrior = locals.length === 0 ? 1 : prior ? priorWeightFor(nLocal, inputs.k0) : 0;
  const wLocal = 1 - wPrior;

  const items: Array<{ q: Quad; w: number }> = [];
  const sources: TaskEstimateExplanation['sources'] = [];
  for (const l of locals) {
    const w = wLocal * (l.n / nLocal);
    items.push({ q: l.q, w });
    sources.push({ source: l.source, n: l.n, weight: w });
  }
  if (prior && wPrior > 0) {
    items.push({ q: prior, w: wPrior });
    sources.push({ source: 'prior', n: prior.n, weight: wPrior });
  }
  const quad = clampP80(logBlend(items.filter((i) => i.w > 0)));

  // Repairs: only clusters and the prior know them. Same n/(n+k0) weighting.
  const priorRepairs = prior && Number.isFinite(prior.repairsPerTask) ? prior.repairsPerTask : null;
  const clRepairs = cl && Number.isFinite(cl.repairsPerTask) ? cl.repairsPerTask : null;
  let expectedRepairs: number;
  if (clRepairs != null && priorRepairs != null) {
    const wp = priorWeightFor(cl!.n, inputs.k0);
    expectedRepairs = (1 - wp) * clRepairs + wp * priorRepairs;
  } else {
    expectedRepairs = clRepairs ?? priorRepairs ?? 0;
  }
  expectedRepairs = Math.max(0, expectedRepairs);

  const base = { ...quad, expectedRepairs };
  const e = { sources, clusterLabel, priorWeight: wPrior };
  return { ...base, explanation: { ...e, summary: formatEstimateSummary(base, e, inputs.kind) } };
}

const roundMinutes = (m: number) => Math.max(5, Math.round(m / 5) * 5);
const roundTokensK = (t: number) => `${Math.max(1, Math.round(t / 1000))}k`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One plain sentence. The range is p50^2/p80 to p80: symmetric around p50 in
 * log space, since only p50 and p80 are known. `kind` is optional and only
 * names the prior ("typical engineering tasks").
 */
export function formatEstimateSummary(
  r: Omit<TaskEstimateResult, 'explanation'>,
  e: Omit<TaskEstimateExplanation, 'summary'>,
  kind?: TaskKind | null,
): string {
  const p50 = roundMinutes(r.p50Minutes);
  const p80 = Math.max(p50, roundMinutes(r.p80Minutes));
  const low = Math.min(p50, roundMinutes((r.p50Minutes * r.p50Minutes) / Math.max(r.p80Minutes, r.p50Minutes)));
  const head = `${p50}m (${low}-${p80}m), ${roundTokensK(r.p50Tokens)} tokens`;

  if (e.sources.length === 0) {
    return `${head}, a default estimate; no history in this repo or in similar work yet.`;
  }

  const local: string[] = [];
  const nb = e.sources.find((s) => s.source === 'neighbours');
  const cl = e.sources.find((s) => s.source === 'clusters');
  if (nb) local.push(`from ${plural(nb.n, 'similar task', 'similar tasks')}`);
  if (cl) local.push(e.clusterLabel ? `work in ${e.clusterLabel}` : plural(cl.n, 'task in this area', 'tasks in this area'));
  const typical = kind ? `typical ${kind} tasks` : 'typical tasks';
  const hasPrior = e.sources.some((s) => s.source === 'prior');

  if (local.length === 0) {
    return `${head}, from ${typical}; no history in this repo yet.`;
  }
  const localText = nb ? local.join(' and ') : `from ${local[0]}`;
  return hasPrior ? `${head}, ${localText}, plus ${typical}.` : `${head}, ${localText}.`;
}
