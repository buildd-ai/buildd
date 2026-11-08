/**
 * Model / configuration comparison over per-attempt model observations.
 * The pure half: rows in, a labelled comparison out. No db, no clock.
 *
 * This EXTENDS the experiment readout (`experiment-readout.ts`): it reuses its
 * Wilson and Newcombe intervals and its "not enough data is a verdict" rule. It
 * is not a second analytics system, and it never decides anything.
 *
 * Rules, each load-bearing:
 *
 * - **Observational unless matched.** Production attempts were not randomised:
 *   which model ran which task was chosen by routing, so every number here is
 *   labelled `observational`. A same-task pairing is "matched" but still not
 *   randomised (a retry follows a failure), so it is labelled
 *   `matched_observational`. Only an experiment readout is controlled, and
 *   that lives elsewhere; `controlled` here only points at it.
 * - **Small samples are not differences.** A rate with fewer than
 *   `MIN_RESOLVED` resolved attempts is `small_sample`. A comparison needs
 *   `MIN_RESOLVED` on both sides AND a Newcombe interval that excludes zero
 *   before it says anything but `insufficient_n` / `no_detectable_difference`.
 *   There is no `winner` field, and `autoPromote` is always false.
 * - **Unknown is not zero.** A missing metric is counted as unknown coverage
 *   and left out of the mean; cost is the sum of KNOWN costs only, with the
 *   count of attempts that had none.
 * - **Correctness is independent.** Quality and delivery come from review, CI,
 *   spec and merge records (`correctnessOf`), never from the worker's own
 *   completion.
 * - **External benchmark priors are never mixed in.** They are returned in
 *   their own block and are not an input to any rate or verdict.
 */
import { correctnessOf, EMPTY_EVIDENCE, type Correctness } from './model-observation';
import { buildV2Profile, isV2Row, type V2Profile } from './model-comparison-v2';
import { newcombeInterval, wilsonInterval, type Interval } from './stat-intervals';

/** Resolved attempts needed per configuration before a rate is more than a hint. */
export const MIN_RESOLVED = 20;
/** Discordant matched pairs needed before a matched comparison may say anything. */
export const MIN_DISCORDANT_PAIRS = 10;

export const COMPARISON_WINDOWS = ['24h', '7d', '30d', '90d'] as const;
export type ComparisonWindow = (typeof COMPARISON_WINDOWS)[number];
const WINDOW_MS: Record<ComparisonWindow, number> = {
  '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000,
};

export function parseComparisonWindow(v: unknown): ComparisonWindow | null {
  return typeof v === 'string' && (COMPARISON_WINDOWS as readonly string[]).includes(v) ? (v as ComparisonWindow) : null;
}

/** The columns of a `model_observations` row the comparison reads. */
export interface ComparisonRow {
  workerId: string;
  taskId: string | null;
  chainId: string | null;
  resolvedModel: string | null;
  endpointKind: string;
  modelVersion: string | null;
  quantization: string | null;
  backend: string | null;
  harnessVersion: string | null;
  runtime: { os?: string; arch?: string; gpu?: string } | null;
  taskClass: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensPerSecond: number | null;
  terminalOutcome: string;
  failureOrigin: string;
  /** Decimal string or number from the column; null = unpriced or unreported. */
  costUsd: string | number | null;
  reviewVerdict: string | null;
  ciState: string | null;
  specVerdict: string | null;
  prOutcome: string | null;
  reworked: boolean;
  /** Set only on controlled replay runs (packages/core/local-eval.ts). */
  evaluation?: { provenance?: string; suiteId?: string; suiteVersion?: string; scoringVersion?: string; caseId?: string; configId?: string; trial?: number; runId?: string; result?: string; v2?: import('./local-eval').RunDetailV2 } | null;
  retries?: number | null;
  peakVramMb?: number | null;
}

export interface ComparisonFilters {
  /** Case-insensitive substring of the resolved model. */
  model?: string;
  /** Case-insensitive substring of the whole configuration label. */
  config?: string;
  /** Substring of the harness version or backend. */
  harness?: string;
  /** Substring of GPU name or `os/arch`. */
  hardware?: string;
  /** Prefix of the task class (`kind/complexity`). */
  taskType?: string;
  window?: ComparisonWindow;
  since?: Date;
  until?: Date;
}

const UNKNOWN = 'unknown';

export interface ConfigIdentity {
  key: string;
  model: string | null;
  endpointKind: string;
  modelVersion: string | null;
  quantization: string | null;
}

/** The configuration an attempt ran under. Unknown parts are spelled out, never dropped. */
export function configOf(r: Pick<ComparisonRow, 'resolvedModel' | 'endpointKind' | 'modelVersion' | 'quantization'>): ConfigIdentity {
  const key = [
    r.resolvedModel ?? 'model unknown',
    r.endpointKind || UNKNOWN,
    r.modelVersion ?? 'version unknown',
    r.quantization ?? 'quantization unknown',
  ].join(' · ');
  return { key, model: r.resolvedModel, endpointKind: r.endpointKind || UNKNOWN, modelVersion: r.modelVersion, quantization: r.quantization };
}

function hardwareLabel(r: ComparisonRow): string | null {
  if (!r.runtime) return null;
  const parts = [r.runtime.gpu, [r.runtime.os, r.runtime.arch].filter(Boolean).join('/')].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

const has = (hay: string | null | undefined, needle: string) => !!hay && hay.toLowerCase().includes(needle.toLowerCase());

/** Apply the filters. An attempt missing the filtered field does not match it. */
export function filterRows(rows: readonly ComparisonRow[], f: ComparisonFilters, now: Date): ComparisonRow[] {
  const since = f.since ?? (f.window ? new Date(now.getTime() - WINDOW_MS[f.window]) : null);
  const until = f.until ?? null;
  return rows.filter((r) => {
    const at = r.startedAt ?? r.createdAt;
    if (since && at < since) return false;
    if (until && at > until) return false;
    if (f.model && !has(r.resolvedModel, f.model)) return false;
    if (f.config && !has(configOf(r).key, f.config)) return false;
    if (f.harness && !(has(r.harnessVersion, f.harness) || has(r.backend, f.harness))) return false;
    if (f.hardware && !has(hardwareLabel(r), f.hardware)) return false;
    if (f.taskType && !(r.taskClass ?? '').toLowerCase().startsWith(f.taskType.toLowerCase())) return false;
    return true;
  });
}

export function correctnessOfRow(r: ComparisonRow): Correctness {
  return correctnessOf({
    ...EMPTY_EVIDENCE,
    reviewVerdict: (r.reviewVerdict as 'approved' | 'changes_requested' | null) ?? null,
    ciState: (r.ciState as 'passed' | 'failed' | null) ?? null,
    specVerdict: (r.specVerdict as 'pass' | 'fail' | null) ?? null,
    prOutcome: (r.prOutcome as 'merged' | 'closed' | null) ?? null,
    reworked: r.reworked,
  });
}

export type SampleStatus = 'no_data' | 'small_sample' | 'established';

export function sampleStatus(resolved: number): SampleStatus {
  if (resolved <= 0) return 'no_data';
  return resolved < MIN_RESOLVED ? 'small_sample' : 'established';
}

export interface RateStat {
  /** Successes among resolved attempts. */
  k: number;
  /** Resolved attempts: the denominator. */
  n: number;
  /** Attempts with no independent record of this kind. Not in the denominator. */
  unknown: number;
  rate: number | null;
  interval: Interval | null;
  status: SampleStatus;
}

function rateStat(k: number, n: number, unknown: number): RateStat {
  return {
    k, n, unknown,
    rate: n > 0 ? k / n : null,
    interval: n > 0 ? wilsonInterval(k, n) : null,
    status: sampleStatus(n),
  };
}

export interface NumericStat { known: number; unknown: number; mean: number | null; median: number | null; p90: number | null }

function quantile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function numericStat(values: Array<number | null>): NumericStat {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (known.length === 0) return { known: 0, unknown: values.length, mean: null, median: null, p90: null };
  const sorted = [...known].sort((a, b) => a - b);
  return {
    known: known.length,
    unknown: values.length - known.length,
    mean: known.reduce((s, v) => s + v, 0) / known.length,
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
  };
}

export interface ConfigSummary {
  key: string;
  identity: ConfigIdentity;
  attempts: number;
  terminal: { completed: number; failed: number; cancelled: number; unknown: number };
  /** Failures by who caused them; only `model` counts against the model. */
  failuresByOrigin: Record<string, number>;
  /** Completed attempts the independent records support, over those they decided. */
  quality: RateStat;
  /** Merged PRs over PRs with a merge/close outcome. */
  delivery: RateStat;
  latencyMs: NumericStat;
  inputTokens: NumericStat;
  outputTokens: NumericStat;
  tokensPerSecond: NumericStat;
  /** Known costs only: `knownUsd` is a floor for the config, never an estimate. */
  cost: { knownCount: number; unknownCount: number; knownUsd: number | null; meanKnownUsd: number | null };
  /** Fields most often missing, so a reader sees what the numbers rest on. */
  coverage: {
    modelVersionUnknown: number;
    quantizationUnknown: number;
    hardwareUnknown: number;
    harnessUnknown: number;
    taskClassUnknown: number;
  };
  sampleStatus: SampleStatus;
  /** Newest first, bounded: the rows behind the numbers. */
  links: Array<{ workerId: string; taskId: string | null; correctness: Correctness; prOutcome: string | null }>;
}

const MAX_LINKS = 20;

export function summarizeConfig(key: string, rows: ComparisonRow[]): ConfigSummary {
  const terminal = { completed: 0, failed: 0, cancelled: 0, unknown: 0 };
  const failuresByOrigin: Record<string, number> = {};
  let qk = 0, qn = 0, qUnknown = 0, dk = 0, dn = 0, dUnknown = 0;
  let costSum = 0, costKnown = 0;
  const cov = { modelVersionUnknown: 0, quantizationUnknown: 0, hardwareUnknown: 0, harnessUnknown: 0, taskClassUnknown: 0 };

  for (const r of rows) {
    const t = r.terminalOutcome as keyof typeof terminal;
    terminal[t in terminal ? t : 'unknown']++;
    if (r.terminalOutcome === 'failed') failuresByOrigin[r.failureOrigin] = (failuresByOrigin[r.failureOrigin] ?? 0) + 1;

    if (r.terminalOutcome === 'completed') {
      const c = correctnessOfRow(r);
      if (c === 'unknown') qUnknown++;
      else { qn++; if (c === 'supported') qk++; }
    }
    if (r.prOutcome === 'merged' || r.prOutcome === 'closed') { dn++; if (r.prOutcome === 'merged') dk++; } else if (r.terminalOutcome === 'completed') dUnknown++;

    const cost = r.costUsd === null || r.costUsd === undefined ? null : Number(r.costUsd);
    if (cost !== null && Number.isFinite(cost) && cost > 0) { costSum += cost; costKnown++; }

    if (!r.modelVersion) cov.modelVersionUnknown++;
    if (!r.quantization) cov.quantizationUnknown++;
    if (!hardwareLabel(r)) cov.hardwareUnknown++;
    if (!r.harnessVersion && !r.backend) cov.harnessUnknown++;
    if (!r.taskClass) cov.taskClassUnknown++;
  }

  const quality = rateStat(qk, qn, qUnknown);
  const newest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, MAX_LINKS);
  return {
    key,
    identity: configOf(rows[0]),
    attempts: rows.length,
    terminal,
    failuresByOrigin,
    quality,
    delivery: rateStat(dk, dn, dUnknown),
    latencyMs: numericStat(rows.map((r) => r.durationMs)),
    inputTokens: numericStat(rows.map((r) => r.inputTokens)),
    outputTokens: numericStat(rows.map((r) => r.outputTokens)),
    tokensPerSecond: numericStat(rows.map((r) => r.tokensPerSecond)),
    cost: {
      knownCount: costKnown,
      unknownCount: rows.length - costKnown,
      knownUsd: costKnown ? costSum : null,
      meanKnownUsd: costKnown ? costSum / costKnown : null,
    },
    coverage: cov,
    sampleStatus: quality.status,
    links: newest.map((r) => ({ workerId: r.workerId, taskId: r.taskId, correctness: correctnessOfRow(r), prOutcome: r.prOutcome })),
  };
}

export type ComparisonVerdict = 'insufficient_n' | 'no_detectable_difference' | 'a_higher' | 'a_lower';

export interface PairComparison {
  a: string;
  b: string;
  metric: 'quality';
  /** a − b in quality rate, with a Newcombe 95% interval. Null while there is nothing to subtract. */
  difference: number | null;
  interval: Interval | null;
  nA: number;
  nB: number;
  verdict: ComparisonVerdict;
}

/**
 * Compare two configurations' quality rate. Below `MIN_RESOLVED` on either side
 * the verdict is `insufficient_n` whatever the point estimates say.
 */
export function compareQuality(a: ConfigSummary, b: ConfigSummary): PairComparison {
  const base = { a: a.key, b: b.key, metric: 'quality' as const, nA: a.quality.n, nB: b.quality.n };
  if (a.quality.n < MIN_RESOLVED || b.quality.n < MIN_RESOLVED) {
    return { ...base, difference: null, interval: null, verdict: 'insufficient_n' };
  }
  const d = newcombeInterval(a.quality.k, a.quality.n, b.quality.k, b.quality.n);
  const verdict: ComparisonVerdict = d.lower > 0 ? 'a_higher' : d.upper < 0 ? 'a_lower' : 'no_detectable_difference';
  return { ...base, difference: d.difference, interval: { lower: d.lower, upper: d.upper }, verdict };
}

export interface MatchedComparison {
  a: string;
  b: string;
  /** Same task attempted under both configurations (not randomised). */
  pairs: number;
  bothSupported: number;
  bothContradicted: number;
  aOnlySupported: number;
  bOnlySupported: number;
  /** Interval of the share of discordant pairs that favour `a`; 0.5 means no preference. */
  shareFavouringA: Interval | null;
  verdict: ComparisonVerdict;
}

/**
 * Same-task pairs. For each task (chain), the latest attempt per configuration
 * with a decided correctness is taken; every two configurations that both ran
 * it form a pair. Only discordant pairs carry information: the verdict needs
 * `MIN_DISCORDANT_PAIRS` of them and a Wilson interval on the share favouring
 * `a` that excludes 0.5.
 */
export function matchedComparisons(rows: readonly ComparisonRow[]): MatchedComparison[] {
  const byTask = new Map<string, Map<string, { c: Correctness; at: number }>>();
  for (const r of rows) {
    const unit = r.chainId ?? r.taskId;
    if (!unit || r.terminalOutcome !== 'completed') continue;
    const c = correctnessOfRow(r);
    if (c === 'unknown') continue;
    const key = configOf(r).key;
    const at = (r.startedAt ?? r.createdAt).getTime();
    const cfgs = byTask.get(unit) ?? new Map();
    const prev = cfgs.get(key);
    if (!prev || prev.at < at) cfgs.set(key, { c, at });
    byTask.set(unit, cfgs);
  }

  const acc = new Map<string, MatchedComparison>();
  for (const cfgs of byTask.values()) {
    const keys = [...cfgs.keys()].sort();
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i], b = keys[j];
        const id = `${a}\u0000${b}`;
        const m = acc.get(id) ?? {
          a, b, pairs: 0, bothSupported: 0, bothContradicted: 0, aOnlySupported: 0, bOnlySupported: 0,
          shareFavouringA: null, verdict: 'insufficient_n' as ComparisonVerdict,
        };
        const ca = cfgs.get(a)!.c, cb = cfgs.get(b)!.c;
        m.pairs++;
        if (ca === 'supported' && cb === 'supported') m.bothSupported++;
        else if (ca === 'contradicted' && cb === 'contradicted') m.bothContradicted++;
        else if (ca === 'supported') m.aOnlySupported++;
        else m.bOnlySupported++;
        acc.set(id, m);
      }
    }
  }

  const out = [...acc.values()];
  for (const m of out) {
    const discordant = m.aOnlySupported + m.bOnlySupported;
    if (discordant < MIN_DISCORDANT_PAIRS) continue;
    const w = wilsonInterval(m.aOnlySupported, discordant);
    m.shareFavouringA = w;
    m.verdict = w.lower > 0.5 ? 'a_higher' : w.upper < 0.5 ? 'a_lower' : 'no_detectable_difference';
  }
  return out.sort((x, y) => y.pairs - x.pairs);
}

/** External benchmark numbers (public leaderboards). A prior about a model, never a measurement of this team's work. */
export interface BenchmarkPrior {
  model: string;
  benchmark: string;
  score: number;
  source: string;
}

export interface ModelComparison {
  generatedAt: string;
  filters: ComparisonFilters;
  evidence: {
    /** Always observational: attempts were routed, not randomised. */
    design: 'observational';
    controlled: { available: false; note: string };
    minResolved: number;
    minDiscordantPairs: number;
  };
  /** Never true. Nothing here changes routing or promotes a model. */
  autoPromote: false;
  totals: { attempts: number; configs: number; filteredOut: number };
  configs: ConfigSummary[];
  /** Each configuration against the one with the most resolved attempts. */
  comparisons: PairComparison[];
  matched: { design: 'matched_observational'; note: string; pairs: MatchedComparison[] };
  priors: { note: string; entries: BenchmarkPrior[] };
  /** Controlled replay runs, kept apart from every production figure above. */
  replay: ReplayComparison;
}

export interface ReplayConfig {
  configId: string;
  summary: ConfigSummary;
  /** Per case: trials run and trials that passed. A trial that errored in the harness is not counted as a model failure. */
  cases: Array<{ caseId: string; trials: number; passes: number; harnessErrors: number }>;
}

export interface ReplayComparison {
  design: 'controlled_replay';
  note: string;
  /** Suite and scoring versions present; results only compare within one pair. */
  versions: Array<{ suiteVersion: string; scoringVersion: string; runs: number }>;
  configs: ReplayConfig[];
  /** Cases every listed configuration has at least one run on. Empty when nothing has been run. */
  commonCases: string[];
  /** Always not_computed: a handful of replayed cases supports no ranking. */
  verdict: 'not_computed' | 'no_runs';
  /** Per-category capability profile of v2 runs. v2 runs are not in `configs` above; v1 runs are not in this. */
  v2: V2Profile;
}

/** Rows ingested by the replay harness; production figures never include them. */
export function isReplayRow(r: ComparisonRow): boolean {
  return r.evaluation?.provenance === 'controlled_replay';
}

export function buildReplayComparison(allReplayRows: readonly ComparisonRow[]): ReplayComparison {
  // v1 keeps its own per-case readout, byte for byte; v2 runs get the per-category profile instead of being pooled into it.
  const rows = allReplayRows.filter((r) => !isV2Row(r));
  const byConfig = new Map<string, ComparisonRow[]>();
  const versions = new Map<string, number>();
  for (const r of rows) {
    const id = r.evaluation?.configId ?? 'config unknown';
    const g = byConfig.get(id);
    if (g) g.push(r); else byConfig.set(id, [r]);
  }
  for (const r of allReplayRows) {
    const vk = `${r.evaluation?.suiteVersion ?? 'unknown'}|${r.evaluation?.scoringVersion ?? 'unknown'}`;
    versions.set(vk, (versions.get(vk) ?? 0) + 1);
  }
  const configs: ReplayConfig[] = [...byConfig.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([configId, g]) => {
    const perCase = new Map<string, { trials: number; passes: number; harnessErrors: number }>();
    for (const r of g) {
      const c = perCase.get(r.evaluation?.caseId ?? 'case unknown') ?? { trials: 0, passes: 0, harnessErrors: 0 };
      if (r.evaluation?.result === 'error') c.harnessErrors++;
      else { c.trials++; if (r.evaluation?.result === 'pass') c.passes++; }
      perCase.set(r.evaluation?.caseId ?? 'case unknown', c);
    }
    return {
      configId,
      summary: summarizeConfig(configId, g),
      cases: [...perCase.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([caseId, c]) => ({ caseId, ...c })),
    };
  });
  const caseSets = configs.map((c) => new Set(c.cases.filter((x) => x.trials > 0).map((x) => x.caseId)));
  const commonCases = caseSets.length ? [...caseSets[0]].filter((id) => caseSets.every((s) => s.has(id))).sort() : [];
  return {
    design: 'controlled_replay',
    note: 'Same cases, prompt, budgets and context for every configuration, replayed from past public fixes. Controlled, but a model may have seen the fix in training: this is replay evidence, not a measure of uncontaminated performance.',
    versions: [...versions.entries()].map(([k, runs]) => { const [suiteVersion, scoringVersion] = k.split('|'); return { suiteVersion, scoringVersion, runs }; }),
    configs,
    commonCases,
    verdict: allReplayRows.length ? 'not_computed' : 'no_runs',
    v2: buildV2Profile(allReplayRows, { minResolved: MIN_RESOLVED }),
  };
}

export function buildModelComparison(
  allRows: readonly ComparisonRow[],
  filters: ComparisonFilters,
  opts: { now?: Date; priors?: readonly BenchmarkPrior[] } = {},
): ModelComparison {
  const now = opts.now ?? new Date();
  // Replay runs are controlled; mixing them into production rates would relabel both.
  const replayRows = allRows.filter(isReplayRow);
  const rows = filterRows(allRows.filter((r) => !isReplayRow(r)), filters, now);
  const groups = new Map<string, ComparisonRow[]>();
  for (const r of rows) {
    const k = configOf(r).key;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const configs = [...groups.entries()]
    .map(([k, g]) => summarizeConfig(k, g))
    .sort((a, b) => b.quality.n - a.quality.n || b.attempts - a.attempts || a.key.localeCompare(b.key));

  const reference = configs[0];
  const comparisons = reference ? configs.slice(1).map((c) => compareQuality(c, reference)) : [];

  const models = new Set(configs.map((c) => (c.identity.model ?? '').toLowerCase()));
  const priors = (opts.priors ?? []).filter((p) => models.has(p.model.toLowerCase()));

  return {
    generatedAt: now.toISOString(),
    filters,
    evidence: {
      design: 'observational',
      controlled: { available: false, note: 'Controlled comparisons are experiment readouts (Health → Experiments). Nothing on this page is randomised. Controlled replay runs of past fixes are reported separately under replay.' },
      minResolved: MIN_RESOLVED,
      minDiscordantPairs: MIN_DISCORDANT_PAIRS,
    },
    autoPromote: false,
    totals: { attempts: rows.length, configs: configs.length, filteredOut: allRows.length - replayRows.length - rows.length },
    configs,
    comparisons,
    matched: {
      design: 'matched_observational',
      note: 'Same task attempted under two configurations. Not randomised: a retry usually follows a failure, so order is confounded.',
      pairs: matchedComparisons(rows),
    },
    priors: {
      note: 'External benchmark results are priors about a model in general. They are not outcomes of this team\'s work and feed no rate above.',
      entries: priors,
    },
    replay: buildReplayComparison(filterRows(replayRows, filters, now)),
  };
}
