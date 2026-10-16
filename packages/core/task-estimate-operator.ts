/**
 * The platform operator's projection of the task-estimates model
 * (docs/specs/task-estimates.md, "Platform operator surface"): live
 * calibration per estimator version across teams, the backtest gate per
 * version, and the write path's coverage and runtime.
 *
 * One scorer. Every live figure comes from `computeTaskEstimateReadout` /
 * `groupScores` (the backtest's `scoreRows`); nothing here re-derives "within
 * p80" or "median actual/p50". The team surface reads the same scorer.
 *
 * Rules this projection holds:
 *
 * - Never pooled across estimator versions: `live` has one entry per version.
 * - Live and backtest never mix. `live` is what finished tasks took against
 *   their frozen estimates in the window; `backtest` is the pinned gate
 *   verdict (`TASK_ESTIMATES_ROLLOUT`) with its bars. A live figure is never
 *   labelled as passing or failing a check.
 * - Unknown is not zero. A slice under `OPERATOR_MIN_SCORED_FOR_RATE` scored
 *   tasks carries its n and null rates with `sufficient: false`; a version with
 *   no measurement reads `unknown`; a measure nobody records reads
 *   `{ status: 'not_instrumented' }`, never 0.
 * - Strings a team wrote (area-cluster labels, which are repo paths) come only
 *   from `detailTeamIds`' rows. Teams and workspaces are keyed by id here; the
 *   web layer names or pseudonymises them (apps/web/src/lib/admin/tenant-privacy.ts).
 *
 * Pure: rows in, a report out. The queries are `./task-estimate-operator-source.ts`.
 */
import type { BacktestScore } from './estimate-backtest';
import { BLEND_BETTER_BAR } from './estimate-backtest-blend';
import type { TaskEstimateExplanation } from './db/schema';
import { ESTIMATOR_VERSION } from './task-estimate';
import { computeTaskEstimateReadout, groupScores, type LiveEstimateRow } from './task-estimate-accuracy';
import {
  TASK_ESTIMATES_GATE, TASK_ESTIMATES_ROLLOUT, taskEstimatesDefaultOn,
  type CalibrationBar, type GateCheckId, type TaskEstimatesRolloutPin,
} from './task-estimate-rollout';

/** Response shape version for the admin app; bump on a breaking change. */
export const OPERATOR_ESTIMATES_SCHEMA_VERSION = 1;

/** Below this many scored tasks a slice shows its n and no rate (the team surface's cut-off too). */
export const OPERATOR_MIN_SCORED_FOR_RATE = 10;

/** One frozen estimate in the window, with its task and, once it finished, its actuals. */
export interface OperatorEstimateRow {
  taskId: string;
  teamId: string;
  workspaceId: string;
  estimatorVersion: string;
  createdAt: Date;
  p50Minutes: number;
  p80Minutes: number;
  p50Tokens: number;
  p80Tokens: number;
  expectedRepairs: number;
  explanation: Pick<TaskEstimateExplanation, 'sources' | 'clusterLabel'>;
  kind: string | null;
  complexity: string | null;
  taskClass: string;
  taskStatus: string;
  /** Null until the task finished and its actuals were stored. */
  actuals: { minutes: number; tokens: number; repairs: number } | null;
  /** Completed work tasks in the workspace when the estimate was made; null when not scored. */
  priorCompleted: number | null;
}

/** Why an estimate in the window is not scored. */
export type ExclusionReason = 'open' | 'ended_without_actuals' | 'non_work' | 'no_usable_actual';
export const EXCLUSION_REASONS: readonly ExclusionReason[] = ['open', 'ended_without_actuals', 'non_work', 'no_usable_actual'];

/** A `BacktestScore` with the rates withheld below the sample bar. */
export interface OperatorScore {
  /** Rows in the slice (scored pool). */
  n: number;
  /** Rows with a usable p50 and actual. */
  scored: number;
  /** False: `scored` is under the bar and every rate is null. Not a good or bad result. */
  sufficient: boolean;
  withinP80: number | null;
  medianRatio: number | null;
  medianAbsLogError: number | null;
}

export interface OperatorGroup { key: string; score: OperatorScore }

export interface OperatorVersionLive {
  estimatorVersion: string;
  /** This is the version new estimates are written under. */
  running: boolean;
  /** Estimate rows of this version created in the window. */
  estimates: number;
  /** Rows that entered scoring (work task, actuals stored). `overall.scored` is the n. */
  eligible: number;
  excluded: Record<ExclusionReason, number>;
  overall: OperatorScore;
  tokens: OperatorScore;
  /** Mean expected vs actual repairs over eligible rows; null with none. */
  repairs: { expected: number; actual: number } | null;
  bySource: OperatorGroup[];
  byKind: OperatorGroup[];
  byComplexity: OperatorGroup[];
  /** Completed tasks the workspace had at estimate time: '0', '1-9', '10-49', '50+'. */
  byHistory: OperatorGroup[];
  /** Keyed by team id; the web layer names it. */
  byTeam: OperatorGroup[];
  /** Keyed by workspace id; the web layer names it. */
  byWorkspace: OperatorGroup[];
  /** Area-cluster labels from the detail teams' rows only; other teams count in every other slice. */
  byCluster: OperatorGroup[];
  /** UTC day of estimate creation (YYYY-MM-DD), ascending. */
  byDay: OperatorGroup[];
}

export type GateResult = 'passed' | 'failed' | 'unknown';

export interface OperatorGateCheck {
  id: GateCheckId;
  /** Which backtest run the check reads: `recent` (`--blend`) or `held_out` (`--held-out <workspace>`). */
  run: 'recent' | 'held_out';
  bar: CalibrationBar | typeof BLEND_BETTER_BAR;
  result: GateResult;
  /**
   * Scored tasks behind the check. Null: the figures live in the evidence
   * artifact (`evidenceRef`), never in this repo, so the API does not have them.
   */
  n: number | null;
}

export interface OperatorGate {
  estimatorVersion: string;
  running: boolean;
  /** `unknown`: no backtest measured this version. */
  verdict: 'go' | 'no_go' | 'unknown';
  measuredOn: string | null;
  evidenceRef: string | null;
  failing: GateCheckId[];
  checks: OperatorGateCheck[];
  /** Whether teams that never chose get estimates under this version right now. */
  defaultOn: boolean;
}

export type Measure<T> = { status: 'measured'; value: T } | { status: 'not_instrumented' };

export interface OperatorCoverage {
  /** Work tasks created in the window in scope. */
  workTasks: number;
  /** Of those, how many got an estimate under each version. */
  byVersion: Array<{ estimatorVersion: string; estimated: number; share: number | null }>;
}

export interface OperatorRuntime {
  /** Estimate rows written in the window, every version. */
  written: number;
  /** Skips and failures are log lines only, not stored. */
  skipped: Measure<number>;
  failed: Measure<number>;
  writeDurationMs: Measure<{ p50: number; p95: number }>;
}

export interface OperatorEstimatesReport {
  schemaVersion: typeof OPERATOR_ESTIMATES_SCHEMA_VERSION;
  runningVersion: string;
  minScoredForRate: number;
  /** The row cap was hit: the oldest estimates in the window are not in `live`. */
  truncated: boolean;
  rowLimit: number;
  live: OperatorVersionLive[];
  backtest: OperatorGate[];
  coverage: OperatorCoverage;
  runtime: OperatorRuntime;
}

export interface OperatorReportInput {
  rows: readonly OperatorEstimateRow[];
  truncated: boolean;
  rowLimit: number;
  /** Teams whose written strings may appear (the owner's own teams). */
  detailTeamIds: ReadonlySet<string>;
  /** Counted in the query, not from `rows`, so the row cap does not shrink them. */
  counts: {
    /** Work tasks created in the window in scope. */
    workTasks: number;
    /** Of those, how many have an estimate, per version. */
    estimatedByVersion: Record<string, number>;
    /** Estimate rows created in the window, every version. */
    written: number;
  };
  /** Narrow `live` to one version; `backtest` still lists every known version. */
  estimatorVersion?: string | null;
  pin?: TaskEstimatesRolloutPin;
  runningVersion?: string;
}

/** Withhold rates under the bar: n shows, the rate does not. */
export function gateScore(s: BacktestScore, min = OPERATOR_MIN_SCORED_FOR_RATE): OperatorScore {
  const sufficient = s.scored >= min;
  return {
    n: s.n,
    scored: s.scored,
    sufficient,
    withinP80: sufficient ? s.withinP80 : null,
    medianRatio: sufficient ? s.medianRatio : null,
    medianAbsLogError: sufficient ? s.medianAbsLogError : null,
  };
}

const gated = (gs: ReadonlyArray<{ key: string; score: BacktestScore }>): OperatorGroup[] =>
  gs.map(g => ({ key: g.key, score: gateScore(g.score) }));

/** Why a row is not scored, or null when it is eligible. */
export function exclusionOf(r: OperatorEstimateRow): Exclude<ExclusionReason, 'no_usable_actual'> | null {
  if (r.taskClass !== 'work') return 'non_work';
  if (r.actuals) return null;
  return r.taskStatus === 'completed' || r.taskStatus === 'failed' || r.taskStatus === 'cancelled' ? 'ended_without_actuals' : 'open';
}

interface Eligible { row: OperatorEstimateRow; live: LiveEstimateRow }

function toLive(r: OperatorEstimateRow): LiveEstimateRow {
  const a = r.actuals!;
  return {
    taskId: r.taskId,
    workspaceId: r.workspaceId,
    estimatorVersion: r.estimatorVersion,
    p50Minutes: r.p50Minutes,
    p80Minutes: r.p80Minutes,
    p50Tokens: r.p50Tokens,
    p80Tokens: r.p80Tokens,
    expectedRepairs: r.expectedRepairs,
    actualMinutes: a.minutes,
    actualTokens: a.tokens,
    actualRepairs: a.repairs,
    kind: r.kind,
    explanation: r.explanation,
    priorCompleted: r.priorCompleted ?? 0,
  };
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

function liveForVersion(version: string, rows: readonly OperatorEstimateRow[], detailTeamIds: ReadonlySet<string>, running: string): OperatorVersionLive {
  const excluded: Record<ExclusionReason, number> = { open: 0, ended_without_actuals: 0, non_work: 0, no_usable_actual: 0 };
  const eligible: Eligible[] = [];
  for (const row of rows) {
    const why = exclusionOf(row);
    if (why) excluded[why]++;
    else eligible.push({ row, live: toLive(row) });
  }
  const live = eligible.map(e => e.live);
  const readout = computeTaskEstimateReadout(live);
  excluded.no_usable_actual = readout.overall.n - readout.overall.scored;
  const by = (keyOf: (e: Eligible) => string, order?: readonly string[]) => {
    const index = new Map(eligible.map(e => [e.live, e] as const));
    return gated(groupScores(live, l => keyOf(index.get(l)!), order));
  };
  const detail = live.filter((_, i) => detailTeamIds.has(eligible[i].row.teamId));
  return {
    estimatorVersion: version,
    running: version === running,
    estimates: rows.length,
    eligible: eligible.length,
    excluded,
    overall: gateScore(readout.overall),
    tokens: gateScore(readout.tokens),
    repairs: readout.repairs,
    bySource: gated(readout.bySource),
    byKind: gated(readout.byKind),
    byComplexity: by(e => e.row.complexity ?? 'unknown'),
    byHistory: readout.byHistory.map(h => ({ key: h.band, score: gateScore(h.score) })),
    byTeam: by(e => e.row.teamId),
    byWorkspace: by(e => e.row.workspaceId),
    byCluster: detail.length ? gated(computeTaskEstimateReadout(detail).byCluster) : [],
    byDay: by(e => utcDay(e.row.createdAt)).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

const CHECK_RUNS: Array<{ id: GateCheckId; run: OperatorGateCheck['run']; bar: OperatorGateCheck['bar'] }> = [
  { id: 'blend_better', run: 'recent', bar: BLEND_BETTER_BAR },
  { id: 'neighbours', run: 'recent', bar: TASK_ESTIMATES_GATE.neighbours },
  { id: 'prior_only', run: 'recent', bar: TASK_ESTIMATES_GATE.priorOnly },
  { id: 'cold_start', run: 'held_out', bar: TASK_ESTIMATES_GATE.coldStart },
];

/**
 * The gate for one version, from the pinned verdict. The pin covers exactly one
 * version; any other reads `unknown` with every check `unknown`. This reads the
 * verdict, it never sets it.
 */
export function gateForVersion(version: string, pin: TaskEstimatesRolloutPin = TASK_ESTIMATES_ROLLOUT, running: string = ESTIMATOR_VERSION): OperatorGate {
  const measured = pin.estimatorVersion === version;
  return {
    estimatorVersion: version,
    running: version === running,
    verdict: measured ? pin.verdict : 'unknown',
    measuredOn: measured ? pin.measuredOn : null,
    evidenceRef: measured ? pin.readoutRef : null,
    failing: measured ? [...pin.failing] : [],
    checks: CHECK_RUNS.map(c => ({
      ...c,
      result: !measured ? 'unknown' : pin.failing.includes(c.id) ? 'failed' : 'passed',
      n: null,
    })),
    defaultOn: version === running && taskEstimatesDefaultOn(pin, running),
  };
}

export function buildOperatorEstimatesReport(input: OperatorReportInput): OperatorEstimatesReport {
  const pin = input.pin ?? TASK_ESTIMATES_ROLLOUT;
  const running = input.runningVersion ?? ESTIMATOR_VERSION;
  const filter = input.estimatorVersion ?? null;

  const byVersion = new Map<string, OperatorEstimateRow[]>();
  for (const r of input.rows) {
    if (filter && r.estimatorVersion !== filter) continue;
    (byVersion.get(r.estimatorVersion) ?? byVersion.set(r.estimatorVersion, []).get(r.estimatorVersion)!).push(r);
  }
  // The asked-for version (by default the running one) always has an entry: zero rows read as zero, rates unknown.
  const anchor = filter ?? running;
  if (!byVersion.has(anchor)) byVersion.set(anchor, []);
  const versionOrder = (a: string, b: string) => (a === running ? -1 : b === running ? 1 : a.localeCompare(b));
  const versions = [...byVersion.keys()].sort(versionOrder);

  const { workTasks, estimatedByVersion, written } = input.counts;
  const gateVersions = [...new Set([running, pin.estimatorVersion, ...versions, ...Object.keys(estimatedByVersion)])].sort(versionOrder);
  const coverageVersions = filter ? [filter] : [...new Set([running, ...Object.keys(estimatedByVersion)])].sort(versionOrder);

  return {
    schemaVersion: OPERATOR_ESTIMATES_SCHEMA_VERSION,
    runningVersion: running,
    minScoredForRate: OPERATOR_MIN_SCORED_FOR_RATE,
    truncated: input.truncated,
    rowLimit: input.rowLimit,
    live: versions.map(v => liveForVersion(v, byVersion.get(v)!, input.detailTeamIds, running)),
    backtest: gateVersions.map(v => gateForVersion(v, pin, running)),
    coverage: {
      workTasks,
      byVersion: coverageVersions.map(v => {
        const estimated = estimatedByVersion[v] ?? 0;
        return { estimatorVersion: v, estimated, share: workTasks > 0 ? estimated / workTasks : null };
      }),
    },
    runtime: {
      written,
      skipped: { status: 'not_instrumented' },
      failed: { status: 'not_instrumented' },
      writeDurationMs: { status: 'not_instrumented' },
    },
  };
}

