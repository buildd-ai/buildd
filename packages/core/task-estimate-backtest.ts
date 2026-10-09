/**
 * Replay completed work tasks in creation order and score a size predictor
 * against what the agents actually spent. Pure — no DB. The query half is
 * `./task-estimate-backtest-source.ts`.
 *
 * Each task is predicted using only what existed at its creation: the history
 * handed to a predictor is the tasks whose first session completed strictly
 * before the cutoff (the same rule as `neighbourSessionsWhere` in
 * `./task-size-estimate.ts`), and the task's own outcome is never in it. The
 * leakage guarantee is structural — a predictor is never given the rows it
 * must not see — and tested with a predictor that asserts on what it receives.
 *
 * ── Readout, same rule as `./task-area-readout.ts` ─────────────────────────
 *
 * A candidate is compared with the baseline on the SAME rows: the rows where
 * both answered, per metric. Predictors that abstain on different rows have
 * different cohorts, so a pooled figure would reward whichever abstains on the
 * hard tasks. Each predictor's answer rate is reported beside the comparison,
 * never folded into it. "No better than the baseline" is a complete result and
 * `formatBacktestReport` states it plainly, with no winner line.
 *
 * ── Cold start ─────────────────────────────────────────────────────────────
 *
 * `coldStart` hides the task's own workspace from its history, and withholds
 * neighbours (the neighbour corpus is per workspace, so a new repo has none).
 * It tests what a predictor does for a repo it has never seen.
 */

export type Metric = 'minutes' | 'tokens';
export const METRICS: readonly Metric[] = ['minutes', 'tokens'];

export interface Quantiles {
  p50: number;
  p80: number;
}

export interface SizeEstimate {
  minutes: Quantiles | null;
  tokens: Quantiles | null;
}

/** A finished task as the backtest sees it: features plus its first session's outcome. */
export interface TaskOutcome {
  taskId: string;
  workspaceId: string;
  createdAt: Date;
  kind: string | null;
  complexity: string | null;
  /** Title + description, the text neighbours are searched with. */
  seedText: string;
  /** First session's completion; the visibility cutoff for later tasks. */
  completedAt: Date;
  /** Agent minutes of that session. Null when it has no positive duration. */
  minutes: number | null;
  /** input + output tokens of that session. Null when none were reported. */
  tokens: number | null;
  /** Files that session changed. The shipped neighbour sizing needs it; others may ignore it. */
  filesChanged: number | null;
}

/** What a predictor may know about the task being predicted. */
export type TaskFeatures = Pick<TaskOutcome, 'taskId' | 'workspaceId' | 'createdAt' | 'kind' | 'complexity' | 'seedText'>;

export interface PredictionContext {
  task: TaskFeatures;
  /** `task.createdAt`. */
  cutoff: Date;
  /** Outcomes completed before the cutoff, oldest completion first. Never the task itself. */
  history: readonly TaskOutcome[];
  /** Ranked neighbour task ids, restricted to `history`. Empty in cold start. */
  neighbours: readonly string[];
}

export interface SizePredictor {
  name: string;
  /** A null metric (or null result) is an abstention, not a zero. */
  predict(ctx: PredictionContext): SizeEstimate | null;
}

export type NeighbourProvider = (task: TaskFeatures, visibleIds: ReadonlySet<string>) => Promise<string[]>;

export interface BacktestOptions {
  predictors: readonly SizePredictor[];
  /** Ranked neighbours for a task. Omitted ⇒ none. */
  neighbours?: NeighbourProvider;
  coldStart?: boolean;
  /** Only score tasks from these workspaces; history still spans all of them. */
  workspaceIds?: readonly string[];
}

export interface PredictionRow {
  taskId: string;
  workspaceId: string;
  kind: string | null;
  complexity: string | null;
  actual: Record<Metric, number | null>;
  /** Per predictor name. Absent metric ⇒ abstained. */
  estimates: Record<string, SizeEstimate | null>;
}

export interface BacktestRun {
  coldStart: boolean;
  predictors: string[];
  rows: PredictionRow[];
  /** Estimates whose p80 was below p50 and were raised to it, per predictor. */
  repaired: Record<string, number>;
}

function sanitize(q: Quantiles | null | undefined): { q: Quantiles | null; repaired: boolean } {
  if (!q || !Number.isFinite(q.p50) || !Number.isFinite(q.p80) || q.p50 < 0 || q.p80 < 0) return { q: null, repaired: false };
  if (q.p80 < q.p50) return { q: { p50: q.p50, p80: q.p50 }, repaired: true };
  return { q, repaired: false };
}

/**
 * Replay in creation order. Ties on `createdAt` break on task id so a run is
 * reproducible. A task's outcome becomes visible to later tasks only when its
 * completion precedes their creation — creation order alone does not make it so.
 */
export async function runBacktest(outcomes: readonly TaskOutcome[], opts: BacktestOptions): Promise<BacktestRun> {
  const ordered = [...outcomes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.taskId.localeCompare(b.taskId));
  const byCompletion = [...outcomes].sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime() || a.taskId.localeCompare(b.taskId));
  const scoped = opts.workspaceIds ? new Set(opts.workspaceIds) : null;
  const names = opts.predictors.map(p => p.name);
  const repaired: Record<string, number> = Object.fromEntries(names.map(n => [n, 0]));
  const rows: PredictionRow[] = [];

  for (const t of ordered) {
    if (scoped && !scoped.has(t.workspaceId)) continue;
    const cutoff = t.createdAt;
    const history = byCompletion.filter(o =>
      o.taskId !== t.taskId &&
      o.completedAt.getTime() < cutoff.getTime() &&
      !(opts.coldStart && o.workspaceId === t.workspaceId));
    const features: TaskFeatures = {
      taskId: t.taskId, workspaceId: t.workspaceId, createdAt: t.createdAt,
      kind: t.kind, complexity: t.complexity, seedText: t.seedText,
    };
    let neighbours: string[] = [];
    if (!opts.coldStart && opts.neighbours) {
      const visible = new Set(history.map(h => h.taskId));
      neighbours = (await opts.neighbours(features, visible)).filter(id => visible.has(id));
    }
    const estimates: Record<string, SizeEstimate | null> = {};
    for (const p of opts.predictors) {
      const raw = p.predict({ task: features, cutoff, history, neighbours });
      if (!raw) { estimates[p.name] = null; continue; }
      const m = sanitize(raw.minutes);
      const k = sanitize(raw.tokens);
      if (m.repaired || k.repaired) repaired[p.name]++;
      estimates[p.name] = m.q || k.q ? { minutes: m.q, tokens: k.q } : null;
    }
    rows.push({
      taskId: t.taskId, workspaceId: t.workspaceId, kind: t.kind, complexity: t.complexity,
      actual: { minutes: t.minutes, tokens: t.tokens },
      estimates,
    });
  }
  return { coldStart: !!opts.coldStart, predictors: names, rows, repaired };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/** Pinball (quantile) loss of estimate `q` at level `tau` for actual `y`. */
export function pinball(tau: number, q: number, y: number): number {
  const d = y - q;
  return d >= 0 ? tau * d : (tau - 1) * d;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface Scores {
  n: number;
  /** Mean |actual − p50|. */
  mae: number;
  /** Median |actual − p50|. */
  medianAbsError: number;
  pinball50: number;
  pinball80: number;
  /** Share of actuals at or below p80. Calibrated ≈ 0.8. */
  p80Coverage: number;
}

export function scoreEstimates(pairs: ReadonlyArray<{ q: Quantiles; y: number }>): Scores {
  const abs = pairs.map(({ q, y }) => Math.abs(y - q.p50));
  return {
    n: pairs.length,
    mae: mean(abs),
    medianAbsError: median(abs),
    pinball50: mean(pairs.map(({ q, y }) => pinball(0.5, q.p50, y))),
    pinball80: mean(pairs.map(({ q, y }) => pinball(0.8, q.p80, y))),
    p80Coverage: pairs.length ? pairs.filter(({ q, y }) => y <= q.p80).length / pairs.length : 0,
  };
}

export interface Delta {
  /** candidate − baseline; negative is better for the three losses. */
  mae: number;
  pinball50: number;
  pinball80: number;
  /** Share of paired rows where the candidate's p50 absolute error was strictly smaller. */
  winShare: number;
  /** 95% bootstrap interval on the mean paired pinball50 difference; null under 10 rows. */
  pinball50Ci: [number, number] | null;
  pinball80Ci: [number, number] | null;
}

export interface GroupComparison {
  group: string;
  /** Rows in the group with an actual for this metric. */
  withActual: number;
  /** Rows where BOTH answered: the only rows any figure below is computed on. */
  paired: number;
  answered: Record<string, number>;
  scores: Record<string, Scores>;
  /** Each non-baseline predictor against the baseline, on the paired rows. */
  deltas: Record<string, Delta>;
}

export interface MetricReport {
  metric: Metric;
  overall: GroupComparison;
  byKind: GroupComparison[];
  byComplexity: GroupComparison[];
}

export interface BacktestReport {
  coldStart: boolean;
  baseline: string;
  predictors: string[];
  rows: number;
  repaired: Record<string, number>;
  metrics: MetricReport[];
}

/** Deterministic PRNG so a report is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapCi(diffs: number[], resamples = 1000): [number, number] | null {
  if (diffs.length < 10) return null;
  const rand = mulberry32(diffs.length * 7919 + 1);
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(rand() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(resamples * 0.025)], means[Math.floor(resamples * 0.975) - 1]];
}

function compareGroup(
  group: string,
  rows: readonly PredictionRow[],
  metric: Metric,
  predictors: readonly string[],
  baseline: string,
): GroupComparison {
  const usable = rows.filter(r => r.actual[metric] !== null);
  const get = (r: PredictionRow, name: string): Quantiles | null => r.estimates[name]?.[metric] ?? null;
  const answered = Object.fromEntries(predictors.map(n => [n, usable.filter(r => get(r, n)).length]));
  const paired = usable.filter(r => predictors.every(n => get(r, n)));
  const pairs = (name: string) => paired.map(r => ({ q: get(r, name)!, y: r.actual[metric]! }));
  const scores = Object.fromEntries(predictors.map(n => [n, scoreEstimates(pairs(n))]));
  const base = pairs(baseline);
  const deltas: Record<string, Delta> = {};
  for (const name of predictors) {
    if (name === baseline) continue;
    const cand = pairs(name);
    const d50 = cand.map((c, i) => pinball(0.5, c.q.p50, c.y) - pinball(0.5, base[i].q.p50, base[i].y));
    const d80 = cand.map((c, i) => pinball(0.8, c.q.p80, c.y) - pinball(0.8, base[i].q.p80, base[i].y));
    const wins = cand.filter((c, i) => Math.abs(c.y - c.q.p50) < Math.abs(base[i].y - base[i].q.p50)).length;
    deltas[name] = {
      mae: scores[name].mae - scores[baseline].mae,
      pinball50: scores[name].pinball50 - scores[baseline].pinball50,
      pinball80: scores[name].pinball80 - scores[baseline].pinball80,
      winShare: cand.length ? wins / cand.length : 0,
      pinball50Ci: bootstrapCi(d50),
      pinball80Ci: bootstrapCi(d80),
    };
  }
  return { group, withActual: usable.length, paired: paired.length, answered, scores, deltas };
}

function groupBy(rows: readonly PredictionRow[], key: (r: PredictionRow) => string | null): Map<string, PredictionRow[]> {
  const out = new Map<string, PredictionRow[]>();
  for (const r of rows) {
    const k = key(r) ?? 'unclassified';
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
}

export function computeBacktestReport(run: BacktestRun, baseline: string): BacktestReport {
  if (!run.predictors.includes(baseline)) throw new Error(`baseline predictor "${baseline}" was not run`);
  const preds = [baseline, ...run.predictors.filter(p => p !== baseline)];
  const metrics = METRICS.map((metric): MetricReport => {
    const section = (key: (r: PredictionRow) => string | null) =>
      [...groupBy(run.rows, key)]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([g, rs]) => compareGroup(g, rs, metric, preds, baseline));
    return {
      metric,
      overall: compareGroup('all', run.rows, metric, preds, baseline),
      byKind: section(r => r.kind),
      byComplexity: section(r => r.complexity),
    };
  });
  return { coldStart: run.coldStart, baseline, predictors: preds, rows: run.rows.length, repaired: run.repaired, metrics };
}

// ── Text ─────────────────────────────────────────────────────────────────────

const f = (n: number, d = 1) => n.toFixed(d);
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const ci = (c: [number, number] | null) => (c ? `[${f(c[0], 2)}, ${f(c[1], 2)}]` : 'n<10');

function formatGroup(g: GroupComparison, report: BacktestReport, lines: string[]): void {
  const answered = report.predictors.map(p => `${p} ${g.answered[p]}`).join(' · ');
  lines.push(`  ${g.group} — ${g.withActual} with an actual · answered: ${answered} · paired ${g.paired}`);
  if (g.paired === 0) {
    lines.push('    no row where every predictor answered — nothing to compare');
    return;
  }
  const w = Math.max(14, ...report.predictors.map(p => p.length)) + 2;
  lines.push(`    ${'predictor'.padEnd(w)}${'MAE'.padStart(10)}${'medAE'.padStart(10)}${'pin50'.padStart(10)}${'pin80'.padStart(10)}${'p80cov'.padStart(8)}`);
  for (const p of report.predictors) {
    const s = g.scores[p];
    lines.push(
      `    ${p.padEnd(w)}${f(s.mae).padStart(10)}${f(s.medianAbsError).padStart(10)}` +
      `${f(s.pinball50, 2).padStart(10)}${f(s.pinball80, 2).padStart(10)}${pct(s.p80Coverage).padStart(8)}`,
    );
  }
  for (const [name, d] of Object.entries(g.deltas)) {
    lines.push(
      `    ${name} − ${report.baseline}: MAE ${f(d.mae)} · pin50 ${f(d.pinball50, 2)} ${ci(d.pinball50Ci)}` +
      ` · pin80 ${f(d.pinball80, 2)} ${ci(d.pinball80Ci)} · closer on ${pct(d.winShare)} of rows`,
    );
  }
}

/**
 * Render the report. States the comparison, not a verdict: a paired interval
 * that spans zero is printed as an interval, and the reader decides.
 */
export function formatBacktestReport(report: BacktestReport): string {
  const lines: string[] = [];
  lines.push(`task size backtest — ${report.coldStart ? 'cold start (own workspace hidden)' : 'warm'}`);
  lines.push(`rows replayed: ${report.rows} · baseline: ${report.baseline}`);
  for (const [name, n] of Object.entries(report.repaired)) {
    if (n > 0) lines.push(`NOTE: ${name} returned p80 < p50 on ${n} rows; p80 was raised to p50.`);
  }
  for (const m of report.metrics) {
    lines.push('');
    lines.push(`══ ${m.metric} (${m.metric === 'minutes' ? 'agent minutes' : 'input + output tokens'})`);
    formatGroup(m.overall, report, lines);
    lines.push('  by kind');
    for (const g of m.byKind) formatGroup(g, report, lines);
    lines.push('  by complexity');
    for (const g of m.byComplexity) formatGroup(g, report, lines);
  }
  lines.push('');
  lines.push('Every figure is computed on paired rows only (all predictors answered, an actual exists).');
  lines.push('A predictor that abstains is judged on the rows it answered, never pooled with the rest;');
  lines.push('compare "answered" counts before reading any gap. pin50/pin80 are pinball losses at');
  lines.push('0.5/0.8 (lower is better); p80cov is the share of actuals at or below p80 (target 80%).');
  lines.push('Intervals are 95% bootstrap on the mean paired loss difference; one spanning zero is a tie.');
  return lines.join('\n');
}
