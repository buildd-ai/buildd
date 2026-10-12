/**
 * Task estimates rollout: the quality gate that decides whether estimates are
 * on by default, and how a team's stored switch reads against it. Pure and
 * client-safe (no db import), so the settings page and the health page show
 * the same verdict the write path obeys.
 *
 * A team's `teams.task_estimates` is three-state, read deliberately:
 *
 * - `{ enabled: true }`  the team turned estimates on: on, whatever the default.
 * - `{ enabled: false }` the team turned them off: off, whatever the default.
 *   An explicit opt-out survives any later default flip.
 * - anything else (NULL, `{}`, a malformed value): the team never chose, so it
 *   follows the platform default. Legacy teams and new teams are both NULL, so
 *   flipping the default reaches them together and none is left behind.
 *
 * The platform default is ON only when the pinned verdict below is `go` AND it
 * was measured on the estimator version that is running. A new estimator
 * version invalidates the pin (back to off) until it is measured again.
 *
 * To flip the default: re-run the backtest (both commands below, from an owner
 * session with read-only production access), check every gate passes, then set
 * `verdict: 'go'` with the new `measuredOn` and `readoutRef`. Exact figures stay
 * in the `estimates-backtest` artifact, never in this public repo.
 *
 *   bun run packages/core/scripts/estimate-backtest.ts --blend --limit 120
 *   bun run packages/core/scripts/estimate-backtest.ts --blend --held-out <workspaceId>
 *
 * Rollback: set `verdict: 'no_go'` (teams that never chose go back to off; teams
 * that turned it on stay on). Frozen estimate rows are kept either way.
 *
 * An estimate is a forecast shown to people. It never orders, holds or starts
 * work: nothing in the claim path, scheduler or mission planner reads it as an
 * input, and this gate does not change that.
 */
import type { BlendComparison } from './estimate-backtest-blend';
import type { BacktestScore } from './estimate-backtest';
import { ESTIMATOR_VERSION } from './task-estimate';

// ── Thresholds ───────────────────────────────────────────────────────────────

export interface CalibrationBar {
  /** Fewest scored tasks the check needs; fewer is "not measured", a fail. */
  minScored: number;
  /** Median actual / p50 must land in [lo, hi]: within 20% of unbiased. */
  ratio: readonly [number, number];
  /** Share of actuals at or under p80. */
  withinP80: number;
}

export interface TaskEstimatesGateThresholds {
  /** Tasks with similar history: the estimate's main case. */
  neighbours: CalibrationBar;
  /** Tasks where only the new-repo prior answered (no similar history). */
  priorOnly: CalibrationBar;
  /** A held-out workspace replayed with no local history: what a new team sees. */
  coldStart: CalibrationBar;
  /** The blend must beat the old neighbour-median estimator overall. */
  requireBlendBetter: true;
}

export const TASK_ESTIMATES_GATE: TaskEstimatesGateThresholds = {
  neighbours: { minScored: 30, ratio: [0.8, 1.25], withinP80: 0.8 },
  priorOnly: { minScored: 30, ratio: [0.8, 1.25], withinP80: 0.75 },
  coldStart: { minScored: 30, ratio: [0.8, 1.25], withinP80: 0.7 },
  requireBlendBetter: true,
};

export type GateCheckId = 'blend_better' | 'neighbours' | 'prior_only' | 'cold_start';

export interface GateCheck {
  id: GateCheckId;
  passed: boolean;
  /** Plain reason, no figures beyond the bar itself. */
  reason: string;
}

export interface TaskEstimatesGateEvidence {
  /** `--blend` over recent tasks. */
  recent: BlendComparison | null;
  /** `--blend --held-out <workspace>`: the cold-start run. */
  heldOut: BlendComparison | null;
}

function checkBar(id: GateCheckId, score: BacktestScore | null | undefined, bar: CalibrationBar): GateCheck {
  if (!score || score.scored < bar.minScored || score.medianRatio == null || score.withinP80 == null) {
    return { id, passed: false, reason: `not measured on at least ${bar.minScored} tasks` };
  }
  const [lo, hi] = bar.ratio;
  if (score.medianRatio < lo || score.medianRatio > hi) {
    return { id, passed: false, reason: `typical task ${score.medianRatio > hi ? 'ran longer' : 'ran shorter'} than estimated, outside ${lo}-${hi}x` };
  }
  if (score.withinP80 < bar.withinP80) {
    return { id, passed: false, reason: `fewer than ${Math.round(bar.withinP80 * 100)}% finished within p80` };
  }
  return { id, passed: true, reason: 'meets the bar' };
}

/** Every check, each pass or fail with a reason. Missing evidence fails. */
export function evaluateTaskEstimatesGate(
  ev: TaskEstimatesGateEvidence,
  t: TaskEstimatesGateThresholds = TASK_ESTIMATES_GATE,
): { verdict: 'go' | 'no_go'; checks: GateCheck[] } {
  const bySource = (src: string) => ev.recent?.byCurrentSource.find(s => s.source === src)?.blend ?? null;
  const checks: GateCheck[] = [
    ev.recent?.verdict === 'blend_better'
      ? { id: 'blend_better', passed: true, reason: 'blend beats the neighbour median' }
      : { id: 'blend_better', passed: false, reason: ev.recent ? `blend verdict: ${ev.recent.verdict}` : 'not measured' },
    checkBar('neighbours', bySource('neighbours'), t.neighbours),
    checkBar('prior_only', bySource('bucket'), t.priorOnly),
    checkBar('cold_start', ev.heldOut?.overall.blend ?? null, t.coldStart),
  ];
  return { verdict: checks.every(c => c.passed) ? 'go' : 'no_go', checks };
}

export function formatGate(r: ReturnType<typeof evaluateTaskEstimatesGate>): string {
  return [
    `Default-on quality gate: ${r.verdict === 'go' ? 'GO' : 'NO-GO'}`,
    ...r.checks.map(c => `  ${c.passed ? 'pass' : 'FAIL'}  ${c.id.padEnd(13)} ${c.reason}`),
  ].join('\n');
}

// ── The pinned verdict ───────────────────────────────────────────────────────

export interface TaskEstimatesRolloutPin {
  verdict: 'go' | 'no_go';
  /** The estimator version the evidence scored. Any other version reads as no_go. */
  estimatorVersion: string;
  measuredOn: string;
  /** Where the figures are: never in this repo. */
  readoutRef: string;
  /** The checks that failed, for the settings page's plain explanation. */
  failing: readonly GateCheckId[];
}

/**
 * Last measured 2026-10-09 (backtest run 2). The blend beat the neighbour
 * median and was well calibrated where similar history existed, but the
 * new-repo prior ran well short of the bar, and almost every scored task came
 * from one long-lived workspace, so cold start was not evidenced. A prior fix
 * has shipped since and has not been re-measured. Off by default until it is.
 */
export const TASK_ESTIMATES_ROLLOUT: TaskEstimatesRolloutPin = {
  verdict: 'no_go',
  estimatorVersion: 'blend-v1',
  measuredOn: '2026-10-09',
  readoutRef: 'buildd artifact estimates-backtest',
  failing: ['prior_only', 'cold_start'],
};

/** Whether teams that never chose get estimates. */
export function taskEstimatesDefaultOn(
  pin: TaskEstimatesRolloutPin = TASK_ESTIMATES_ROLLOUT,
  runningVersion: string = ESTIMATOR_VERSION,
): boolean {
  return pin.verdict === 'go' && pin.estimatorVersion === runningVersion;
}

// ── A team's switch ──────────────────────────────────────────────────────────

/** `team`: the team chose. `default`: it never did and follows the platform. */
export type TaskEstimatesSource = 'team' | 'default';

export interface TaskEstimatesState {
  enabled: boolean;
  source: TaskEstimatesSource;
  /** What a team that never chose gets right now. */
  defaultOn: boolean;
}

/** Only a boolean `enabled` is a choice; anything else follows the default. */
export function resolveTaskEstimatesState(raw: unknown, defaultOn: boolean = taskEstimatesDefaultOn()): TaskEstimatesState {
  const chosen = !!raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).enabled : undefined;
  if (typeof chosen === 'boolean') return { enabled: chosen, source: 'team', defaultOn };
  return { enabled: defaultOn, source: 'default', defaultOn };
}

const FAILING_LINE: Record<GateCheckId, string> = {
  blend_better: 'the blended estimate has not beaten the simpler one',
  neighbours: 'estimates from similar past tasks are not yet within the bar',
  prior_only: 'repos with little history ran well past their estimates',
  cold_start: 'a brand-new repo has not been measured yet',
};

/** One plain sentence on why estimates are not on by default, or null when they are. */
export function defaultOffReason(pin: TaskEstimatesRolloutPin = TASK_ESTIMATES_ROLLOUT, runningVersion: string = ESTIMATOR_VERSION): string | null {
  if (taskEstimatesDefaultOn(pin, runningVersion)) return null;
  if (pin.estimatorVersion !== runningVersion) return 'The current estimator has not been checked against finished work yet.';
  const lines = pin.failing.map(id => FAILING_LINE[id]);
  if (lines.length === 0) return 'The accuracy check has not passed yet.';
  const joined = lines.length === 1 ? lines[0] : `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`;
  return `Not on by default yet: ${joined}.`;
}
